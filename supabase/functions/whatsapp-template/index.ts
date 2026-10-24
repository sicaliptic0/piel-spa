import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, jsonResponse } from "../_shared/clinic.ts";
import { whatsappConnected } from "../_shared/whatsapp.ts";
import { sendTemplate } from "../_shared/sendTemplate.ts";

// Sends an approved template (works outside the 24 h window) from the admin:
//   { template, params: string[], patient_id?, phone?, appointment_id? }
// Only admins. The message is saved in the patient's chat (created if new),
// linked to the appointment so the patient's button reply can update it.

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
    const result = await sendTemplate(adminClient, {
      template: String(body?.template || ""),
      params: Array.isArray(body?.params) ? body.params : [],
      patientId: String(body?.patient_id || "") || null,
      phone: body?.phone ? String(body.phone) : null,
      appointmentId: body?.appointment_id ? String(body.appointment_id) : null,
      staffUserId: user.id,
    });
    if (!result.ok) {
      const status = result.error === "send_failed" ? 502 : 400;
      return jsonResponse(result, status);
    }
    return jsonResponse({ ok: true, conversation_id: result.conversationId, message_id: result.messageId, wa_message_id: result.waMessageId });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
