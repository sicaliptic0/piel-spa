import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, jsonResponse } from "../_shared/clinic.ts";
import { inviteTemplate } from "../_shared/marketing.ts";
import { sendWhatsAppMessage, toWhatsAppId, whatsappConnected } from "../_shared/whatsapp.ts";

// Admin → Pacientes → "Promociones WhatsApp": sends the approved invitation
// template ("¿Te gustaría recibir promociones?" + Sí, quiero / No, gracias) to
// every patient who was never asked (marketing_consent is null), has a phone,
// and hasn't been invited before. The answers come back through
// whatsapp-webhook, which saves them on the profile.
//   { dry_run: true } → only counts who would get it.
// Only admins. Each invitation also shows in the "Mensajes" chat.

const MAX_PER_RUN = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return jsonResponse({ error: "Missing required env vars" }, 500);
  const db = createClient(supabaseUrl, serviceRole);

  try {
    // ---------- Admin only ----------
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: authData } = await db.auth.getUser(token);
    const user = authData?.user;
    if (!user) return jsonResponse({ error: "not_signed_in" }, 401);
    const { data: role } = await db.from("staff_roles").select("role").eq("user_id", user.id).maybeSingle();
    if (role?.role !== "admin") return jsonResponse({ error: "not_allowed" }, 403);

    const body = await req.json().catch(() => ({}));

    // ---------- Who gets it ----------
    const { data: staff } = await db.from("staff_roles").select("user_id");
    const staffIds = new Set((staff || []).map((s: { user_id: string }) => s.user_id));
    const { data: profiles, error } = await db.from("profiles")
      .select("id, first_name, phone")
      .is("marketing_consent", null).is("marketing_invite_sent_at", null)
      .not("phone", "is", null);
    if (error) return jsonResponse({ error: error.message }, 500);

    const seen = new Set<string>();
    const targets = (profiles || [])
      .filter((p: { id: string }) => !staffIds.has(p.id))
      .map((p: { id: string; first_name: string | null; phone: string }) => ({ ...p, waId: toWhatsAppId(p.phone) }))
      .filter((p: { waId: string }) => p.waId && !seen.has(p.waId) && seen.add(p.waId));

    if (body?.dry_run) return jsonResponse({ ok: true, pending: targets.length });
    if (!whatsappConnected()) return jsonResponse({ error: "whatsapp_not_connected" }, 503);

    // ---------- Send ----------
    const template = inviteTemplate();
    let sent = 0;
    const failed: { name: string; error: string }[] = [];
    for (const p of targets.slice(0, MAX_PER_RUN)) {
      const firstName = String(p.first_name || "").trim().split(/\s+/)[0] || "👋";
      let waMessageId = "";
      try {
        waMessageId = await sendWhatsAppMessage(p.waId, {
          type: "template",
          template: {
            name: template.name,
            language: { code: template.language },
            components: [{ type: "body", parameters: [{ type: "text", text: firstName }] }],
          },
        });
      } catch (e) {
        const message = (e as Error).message;
        failed.push({ name: firstName, error: message });
        // Template missing / not approved: every other send would fail the same way.
        if (/132001|132000|template/i.test(message) && sent === 0 && failed.length >= 2) break;
        continue;
      }
      sent++;
      await db.from("profiles").update({ marketing_invite_sent_at: new Date().toISOString() }).eq("id", p.id);

      // Show it in the patient's chat ("Mensajes").
      await db.from("wa_conversations").upsert({ phone: p.waId, patient_id: p.id }, { onConflict: "phone", ignoreDuplicates: true });
      const { data: conv } = await db.from("wa_conversations").select("id").eq("phone", p.waId).maybeSingle();
      if (conv) {
        await db.from("wa_messages").insert({
          conversation_id: conv.id, direction: "out", sender: "system",
          body: `📣 Invitación a recibir promociones (plantilla "${template.name}")`,
          wa_message_id: waMessageId || null, status: "sent",
        });
      }
    }

    return jsonResponse({ ok: true, sent, failed, remaining: Math.max(0, targets.length - sent - failed.length) });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
