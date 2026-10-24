import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, jsonResponse } from "../_shared/clinic.ts";
import { sendWhatsAppMessage, toWhatsAppId, whatsappConnected } from "../_shared/whatsapp.ts";
import { TEMPLATES, TEMPLATE_LANGUAGE } from "../_shared/templates.ts";

// Sends an approved template (works outside the 24 h window) from the admin:
//   { template, params: string[], patient_id?, phone? }
// Only admins. The phone comes from the patient's profile unless given. The
// message is saved in the patient's chat (created if new), so it shows in
// Mensajes like any other.

function renderTemplate(name: string, params: string[]): string {
  const t = TEMPLATES.find((x) => x.name === name)!;
  const body = t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? "");
  return [t.header, body].filter(Boolean).join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return jsonResponse({ error: "Missing required env vars" }, 500);
  const adminClient = createClient(supabaseUrl, serviceRole);

  try {
    // ---------- Admin only ----------
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: authData } = await adminClient.auth.getUser(token);
    const user = authData?.user;
    if (!user) return jsonResponse({ error: "not_signed_in" }, 401);
    const { data: role } = await adminClient.from("staff_roles").select("role").eq("user_id", user.id).maybeSingle();
    if (role?.role !== "admin") return jsonResponse({ error: "not_allowed" }, 403);

    if (!whatsappConnected()) return jsonResponse({ error: "whatsapp_not_connected" }, 503);

    const body = await req.json();
    const name = String(body?.template || "");
    const template = TEMPLATES.find((t) => t.name === name);
    if (!template) return jsonResponse({ error: "unknown_template" }, 400);
    const params = (Array.isArray(body?.params) ? body.params : []).map((p: unknown) => String(p ?? "").trim());
    if (params.length !== template.params.length || params.some((p: string) => !p)) {
      return jsonResponse({ error: "invalid_params", expected: template.params }, 400);
    }

    const patientId = String(body?.patient_id || "") || null;
    let phone = toWhatsAppId(body?.phone);
    let profileName = "";
    if (patientId) {
      const { data: profile } = await adminClient.from("profiles").select("first_name, last_name, phone").eq("id", patientId).maybeSingle();
      if (!phone) phone = toWhatsAppId(profile?.phone);
      profileName = `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim();
    }
    if (!phone) return jsonResponse({ error: "no_phone" }, 400);

    // The patient's chat, created on the first message.
    let { data: conv } = await adminClient.from("wa_conversations").select("id, patient_id").eq("phone", phone).maybeSingle();
    if (!conv) {
      const { data: created, error } = await adminClient.from("wa_conversations")
        .insert({ phone, patient_id: patientId, profile_name: profileName || null, bot_active: false })
        .select("id, patient_id").single();
      if (error) return jsonResponse({ error: error.message }, 500);
      conv = created;
    } else if (!conv.patient_id && patientId) {
      await adminClient.from("wa_conversations").update({ patient_id: patientId }).eq("id", conv.id);
    }

    let waMessageId = "";
    let sendError = "";
    try {
      waMessageId = await sendWhatsAppMessage(phone, {
        type: "template",
        template: {
          name,
          language: { code: TEMPLATE_LANGUAGE },
          components: [{ type: "body", parameters: params.map((text: string) => ({ type: "text", text })) }],
        },
      });
    } catch (e) {
      sendError = (e as Error).message;
    }

    const { data: saved } = await adminClient.from("wa_messages").insert({
      conversation_id: conv!.id,
      direction: "out",
      sender: "staff",
      staff_user_id: user.id,
      body: renderTemplate(name, params),
      wa_message_id: waMessageId || null,
      status: sendError ? "failed" : "sent",
      error: sendError || null,
    }).select("id").single();

    if (sendError) return jsonResponse({ error: "send_failed", detail: sendError, message_id: saved?.id }, 502);
    return jsonResponse({ ok: true, conversation_id: conv!.id, message_id: saved?.id, wa_message_id: waMessageId });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
