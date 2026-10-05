import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { emailConfig, escapeHtml, sendEmail } from "../_shared/clinic.ts";
import { sendPushToStaff } from "../_shared/push.ts";
import { downloadWhatsAppMedia, extensionFor, validWebhookSignature, whatsappConfig } from "../_shared/whatsapp.ts";

// Meta calls this for every incoming WhatsApp message and every delivery
// status. Deployed with --no-verify-jwt (Meta doesn't send a Supabase key);
// instead every POST must carry Meta's signature (X-Hub-Signature-256).
//   GET  — one-time verification when the webhook is set up in Meta.
//   POST — messages: find/create the conversation (matched to the patient by
//          phone), save the message, download any photo/file into wa-media;
//          statuses: sent → delivered → read / failed on our own messages.
// Every incoming message pushes a notification to the staff phones that turned
// alerts on (one per chat, updated in place). When a chat starts waiting for
// staff, the clinic also gets an email (once per waiting period, not per message).

const MEDIA_TYPES = ["image", "document", "audio", "video", "sticker"];

// deno-lint-ignore no-explicit-any
type Json = any;

async function findPatientId(db: SupabaseClient, waId: string): Promise<string | null> {
  const last10 = waId.slice(-10);
  if (last10.length < 10) return null;
  const { data } = await db.from("profiles").select("id").ilike("phone", `%${last10}`).limit(2);
  return data?.length === 1 ? data[0].id : null; // ambiguous → leave unlinked
}

async function getOrCreateConversation(db: SupabaseClient, waId: string, profileName: string) {
  const { data: existing } = await db.from("wa_conversations")
    .select("id, needs_attention, patient_id, profile_name").eq("phone", waId).maybeSingle();
  if (existing) {
    const updates: Record<string, unknown> = {};
    if (profileName && profileName !== existing.profile_name) updates.profile_name = profileName;
    if (!existing.patient_id) {
      const patientId = await findPatientId(db, waId);
      if (patientId) updates.patient_id = patientId;
    }
    if (Object.keys(updates).length) await db.from("wa_conversations").update(updates).eq("id", existing.id);
    return existing;
  }
  const { data: created, error } = await db.from("wa_conversations")
    .insert({ phone: waId, profile_name: profileName || null, patient_id: await findPatientId(db, waId) })
    .select("id, needs_attention, patient_id, profile_name").single();
  if (error) {
    // Created by a parallel delivery a moment ago.
    const { data: again } = await db.from("wa_conversations")
      .select("id, needs_attention, patient_id, profile_name").eq("phone", waId).single();
    return again;
  }
  return created;
}

function messageText(m: Json): string {
  switch (m.type) {
    case "text": return m.text?.body ?? "";
    case "button": return m.button?.text ?? "";
    case "interactive": return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
    case "location": return `📍 ${m.location?.name ?? ""} ${m.location?.address ?? ""} https://maps.google.com/?q=${m.location?.latitude},${m.location?.longitude}`.trim();
    case "contacts": return `👤 ${(m.contacts ?? []).map((c: Json) => c.name?.formatted_name).join(", ")}`;
    case "reaction": return `${m.reaction?.emoji ?? ""} (reacción)`;
    default: return MEDIA_TYPES.includes(m.type) ? (m[m.type]?.caption ?? "") : `[${m.type}]`;
  }
}

async function handleMessage(db: SupabaseClient, m: Json, contacts: Json[]) {
  const waId = String(m.from || "");
  if (!waId) return;
  const profileName = String(contacts.find((c) => c.wa_id === waId)?.profile?.name ?? "");
  const conv = await getOrCreateConversation(db, waId, profileName);
  if (!conv) return;

  const row: Record<string, unknown> = {
    conversation_id: conv.id,
    direction: "in",
    sender: "patient",
    body: messageText(m) || null,
    wa_message_id: m.id,
    status: "received",
    created_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
  };

  if (MEDIA_TYPES.includes(m.type) && m[m.type]?.id) {
    const media = m[m.type];
    row.media_type = m.type;
    row.media_filename = media.filename ?? null;
    try {
      const { bytes, mime } = await downloadWhatsAppMedia(media.id);
      const path = `inbound/${conv.id}/${m.id}.${extensionFor(mime, media.filename)}`;
      const { error } = await db.storage.from("wa-media").upload(path, bytes, { contentType: mime || undefined, upsert: true });
      if (error) throw error;
      row.media_path = path;
      row.media_mime = mime;
    } catch (e) {
      row.error = `media: ${(e as Error).message}`;
    }
  }

  // Duplicate deliveries from Meta (same wa_message_id) are ignored.
  const { error } = await db.from("wa_messages").insert(row);
  if (error && !String(error.message).includes("duplicate")) console.error("save message:", error.message);
  if (error) return;

  const { data: after } = await db.from("wa_conversations").select("needs_attention, profile_name, patient_id").eq("id", conv.id).single();
  const name = await displayName(db, waId, after ?? conv);
  const preview = String(row.body || ({ image: "📷 Foto", document: "📄 Documento", audio: "🎤 Audio", video: "🎥 Video" } as Record<string, string>)[String(row.media_type)] || "📎 Archivo");

  // While the AI handles the chat (Phase 4) staff phones stay quiet.
  if (after?.needs_attention) {
    await sendPushToStaff(db, {
      title: `WhatsApp · ${name}`,
      body: preview.slice(0, 180),
      tag: conv.id,
      conversationId: conv.id,
      url: `/admin.html#mensajes&chat=${conv.id}`,
    });
  }
  // First message of a new waiting period → email the clinic.
  if (after?.needs_attention && !conv.needs_attention) await alertStaff(waId, name, preview);
}

async function displayName(db: SupabaseClient, waId: string, conv: Json): Promise<string> {
  if (conv?.patient_id) {
    const { data: p } = await db.from("profiles").select("first_name, last_name").eq("id", conv.patient_id).maybeSingle();
    const full = `${p?.first_name ?? ""} ${p?.last_name ?? ""}`.trim();
    if (full) return full;
  }
  return conv?.profile_name || `+${waId}`;
}

async function alertStaff(waId: string, name: string, preview: string) {
  const { resendApiKey, from, staffEmail } = emailConfig();
  if (!resendApiKey || !staffEmail) return;
  try {
    await sendEmail(resendApiKey, from, [staffEmail], `💬 WhatsApp por responder: ${name}`, `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
        <div style="background:#2A2330; padding:20px 32px;"><h1 style="margin:0; color:#B76E88; font-family: Georgia, serif; font-size:18px; letter-spacing:3px;">PIEL SPA · WHATSAPP</h1></div>
        <div style="background:#fff; padding:28px 32px; font-size:14px; line-height:1.7;">
          <p style="margin-top:0;"><strong>${escapeHtml(name)}</strong> (+${escapeHtml(waId)}) escribió:</p>
          <p style="background:#F3F4F6; border-radius:8px; padding:12px 16px;">${escapeHtml(preview.slice(0, 500))}</p>
          <p><a href="https://piel-spa.com/admin.html#mensajes" style="background:#B76E88; color:#fff; text-decoration:none; padding:10px 18px; border-radius:6px; font-size:12px; letter-spacing:1px; text-transform:uppercase; font-weight:bold;">Responder en el panel</a></p>
        </div>
      </div>`);
  } catch (e) {
    console.error("staff alert:", (e as Error).message);
  }
}

async function handleStatus(db: SupabaseClient, s: Json) {
  const order = ["sent", "delivered", "read"];
  const { data: msg } = await db.from("wa_messages").select("id, status").eq("wa_message_id", s.id).maybeSingle();
  if (!msg) return;
  if (s.status === "failed") {
    const err = s.errors?.[0];
    await db.from("wa_messages").update({ status: "failed", error: err ? `${err.code} ${err.title ?? err.message ?? ""}` : "failed" }).eq("id", msg.id);
  } else if (order.indexOf(s.status) > order.indexOf(msg.status)) {
    await db.from("wa_messages").update({ status: s.status }).eq("id", msg.id); // never go backwards
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe"
      && url.searchParams.get("hub.verify_token") === whatsappConfig().verifyToken
      && !!whatsappConfig().verifyToken;
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await validWebhookSignature(raw, req.headers.get("x-hub-signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const payload = JSON.parse(raw);
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        for (const m of value.messages ?? []) await handleMessage(db, m, value.contacts ?? []);
        for (const s of value.statuses ?? []) await handleStatus(db, s);
      }
    }
  } catch (e) {
    // Still answer 200: a non-2xx makes Meta retry the same payload for days.
    console.error("whatsapp-webhook:", (e as Error).message);
  }
  return new Response("ok", { status: 200 });
});
