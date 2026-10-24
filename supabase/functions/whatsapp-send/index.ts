import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, jsonResponse } from "../_shared/clinic.ts";
import { sendWhatsAppMessage, whatsappConnected } from "../_shared/whatsapp.ts";
import { sendTemplate } from "../_shared/sendTemplate.ts";

// Staff reply from the admin's "Mensajes" view.
//   { conversation_id, text?, media_path?, media_type?, media_mime?, media_filename? }
// With the 24 h window closed, a "door opener" instead:
//   { conversation_id, text?, opener: { template, params } }
// sends the approved template now and keeps the text in wa_pending_messages;
// whatsapp-webhook delivers it as soon as the patient answers.
// Only admins. A file is uploaded to the wa-media bucket by the page first;
// here it's handed to WhatsApp as a short-lived link. Sending as staff takes
// the chat over (bot_active = false) — the AI stops answering it.

const WINDOW_MS = 24 * 3600 * 1000;
// Templates staff can open a closed chat with (supabase/functions/_shared/templates.ts).
const OPENER_TEMPLATES = ["mensaje_tratamiento", "seguimiento_tratamiento", "recordatorio_retoque"];

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
    const text = String(body?.text || "").trim();

    if (body?.opener) return await sendOpener(adminClient, user.id, String(body?.conversation_id || ""), text, body.opener);

    const mediaPath = String(body?.media_path || "").trim();
    const mediaType = String(body?.media_type || "").trim(); // image | document
    if (!text && !mediaPath) return jsonResponse({ error: "empty" }, 400);
    if (mediaPath && !["image", "document"].includes(mediaType)) return jsonResponse({ error: "invalid_media_type" }, 400);

    const { data: conv } = await adminClient
      .from("wa_conversations").select("id, phone, last_inbound_at").eq("id", String(body?.conversation_id || "")).maybeSingle();
    if (!conv) return jsonResponse({ error: "not_found" }, 404);

    // WhatsApp only allows free-form messages within 24 h of the patient's last
    // message; after that it takes an approved template (added later).
    if (!conv.last_inbound_at || Date.now() - new Date(conv.last_inbound_at).getTime() > WINDOW_MS) {
      return jsonResponse({ error: "window_closed" }, 409);
    }

    let payload: Record<string, unknown>;
    if (mediaPath) {
      const { data: signed, error: signError } = await adminClient.storage.from("wa-media").createSignedUrl(mediaPath, 3600);
      if (signError || !signed?.signedUrl) return jsonResponse({ error: "media_not_found" }, 400);
      payload = mediaType === "image"
        ? { type: "image", image: { link: signed.signedUrl, ...(text ? { caption: text } : {}) } }
        : { type: "document", document: { link: signed.signedUrl, filename: String(body?.media_filename || "documento.pdf"), ...(text ? { caption: text } : {}) } };
    } else {
      payload = { type: "text", text: { body: text, preview_url: true } };
    }

    let waMessageId = "";
    let sendError = "";
    try {
      waMessageId = await sendWhatsAppMessage(conv.phone, payload);
    } catch (e) {
      sendError = (e as Error).message;
    }

    const { data: saved } = await adminClient.from("wa_messages").insert({
      conversation_id: conv.id,
      direction: "out",
      sender: "staff",
      staff_user_id: user.id,
      body: text || null,
      media_type: mediaPath ? mediaType : null,
      media_path: mediaPath || null,
      media_mime: mediaPath ? String(body?.media_mime || "") || null : null,
      media_filename: mediaPath ? String(body?.media_filename || "") || null : null,
      wa_message_id: waMessageId || null,
      status: sendError ? "failed" : "sent",
      error: sendError || null,
    }).select("id").single();

    if (sendError) return jsonResponse({ error: "send_failed", detail: sendError, message_id: saved?.id }, 502);

    // Staff replied: the chat is in human mode from now on.
    await adminClient.from("wa_conversations")
      .update({ bot_active: false, human_since: new Date().toISOString(), human_by: user.id })
      .eq("id", conv.id).eq("bot_active", true);

    return jsonResponse({ ok: true, message_id: saved?.id, wa_message_id: waMessageId });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});

// deno-lint-ignore no-explicit-any
async function sendOpener(db: any, userId: string, conversationId: string, text: string, opener: any) {
  const template = String(opener?.template || "");
  if (!OPENER_TEMPLATES.includes(template)) return jsonResponse({ error: "unknown_template" }, 400);
  if (template === "mensaje_tratamiento" && !text) return jsonResponse({ error: "empty" }, 400);

  const { data: conv } = await db.from("wa_conversations").select("id, phone, patient_id").eq("id", conversationId).maybeSingle();
  if (!conv) return jsonResponse({ error: "not_found" }, 404);

  let pendingId: string | null = null;
  if (text) {
    const { data: pending, error } = await db.from("wa_pending_messages")
      .insert({ conversation_id: conv.id, body: text, created_by: userId }).select("id").single();
    if (error) return jsonResponse({ error: error.message }, 500);
    pendingId = pending.id;
  }

  const result = await sendTemplate(db, {
    template,
    params: Array.isArray(opener?.params) ? opener.params : [],
    patientId: conv.patient_id,
    phone: conv.phone,
    staffUserId: userId,
  });
  if (!result.ok) {
    if (pendingId) await db.from("wa_pending_messages").delete().eq("id", pendingId);
    return jsonResponse(result, result.error === "send_failed" ? 502 : 400);
  }
  if (pendingId) await db.from("wa_pending_messages").update({ opener_message_id: result.messageId ?? null }).eq("id", pendingId);

  // Staff is handling this chat.
  await db.from("wa_conversations")
    .update({ bot_active: false, human_since: new Date().toISOString(), human_by: userId })
    .eq("id", conv.id).eq("bot_active", true);

  return jsonResponse({ ok: true, opener: true, pending_id: pendingId, message_id: result.messageId });
}
