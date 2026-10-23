import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { emailConfig, escapeHtml, sendEmail } from "../_shared/clinic.ts";
import { sendPushToStaff } from "../_shared/push.ts";
import { consentFields, consentReply } from "../_shared/marketing.ts";
import {
  downloadWhatsAppMedia, extensionFor, sendWhatsAppMessage, validWebhookSignature, whatsappConfig,
} from "../_shared/whatsapp.ts";

// Meta calls this for every incoming WhatsApp message and every delivery
// status. Deployed with --no-verify-jwt (Meta doesn't send a Supabase key);
// instead every POST must carry Meta's signature (X-Hub-Signature-256).
//   GET  — one-time verification when the webhook is set up in Meta.
//   POST — messages: find/create the conversation (matched to the patient by
//          phone), save the message, download any photo/file into wa-media;
//          statuses: sent → delivered → read / failed on our own messages.
// Every incoming message pushes a notification to the staff phones that turned
// alerts on (one per chat, updated in place), carrying the unread total for the
// home-screen icon badge and which chats are still unread, so each phone drops
// notifications for chats someone already read. The email alert to the clinic
// is off unless the WHATSAPP_EMAIL_ALERTS secret is "on".
//
// Coexistence (WhatsApp Business app + this system on the same number, through
// Dualhook's webhook override):
//   - Override deliveries are signed with the partner's app secret, not ours, so
//     a POST is also accepted when the URL carries ?k=<WHATSAPP_WEBHOOK_KEY>.
//   - smb_message_echoes: what staff send from the WhatsApp Business app → shown
//     in the chat as staff messages, and the chat switches to human mode.
//   - history: up to 180 days of past chats, sent ONCE right after connecting.
//   - smb_app_state_sync: contact names from the app.
//   These, account_update and any unknown field are first saved untouched to
//   wa-media/raw/ (private), so they can be re-processed by whatsapp-diagnose if
//   something was read wrong — the history sync can't be requested twice.

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

  // Meta couldn't deliver the content (type "unsupported"): keep its reason, and
  // a raw copy (private bucket) to see what the patient's app sent.
  if (m.type === "unsupported" || m.errors) {
    const err = m.errors?.[0];
    row.error = err ? `${err.code ?? ""} ${err.title ?? ""} ${err.error_data?.details ?? err.message ?? ""}`.trim() : "unsupported";
    await saveRaw(db, "unsupported", null, m);
  }

  // Duplicate deliveries from Meta (same wa_message_id) are ignored.
  const { error } = await db.from("wa_messages").insert(row);
  if (error && !String(error.message).includes("duplicate")) console.error("save message:", error.message);
  if (error) return;

  // Answer to the promotions invitation, or an opt-out word ("BAJA", "STOP"):
  // saved on the patient's profile and acknowledged — no staff needed.
  const consent = consentReply(String(row.body || ""));
  if (consent) {
    await handleConsentReply(db, conv.id, waId, consent);
    return;
  }

  const { data: after } = await db.from("wa_conversations").select("needs_attention, profile_name, patient_id").eq("id", conv.id).single();
  const name = await displayName(db, waId, after ?? conv);
  const preview = String(row.body || ({ image: "📷 Foto", document: "📄 Documento", audio: "🎤 Audio", video: "🎥 Video" } as Record<string, string>)[String(row.media_type)] || "📎 Archivo");

  // While the AI handles the chat (Phase 4) staff phones stay quiet.
  if (after?.needs_attention) {
    const { data: unreadChats } = await db.from("wa_conversations").select("id, unread_count").gt("unread_count", 0);
    await sendPushToStaff(db, {
      title: `WhatsApp · ${name}`,
      body: preview.slice(0, 180),
      tag: conv.id,
      conversationId: conv.id,
      url: `/admin.html#mensajes&chat=${conv.id}`,
      badge: (unreadChats ?? []).reduce((sum, c) => sum + (c.unread_count || 0), 0),
      unreadConversationIds: (unreadChats ?? []).map((c) => c.id),
    });
  }
  // First message of a new waiting period → email the clinic (only if enabled).
  if (Deno.env.get("WHATSAPP_EMAIL_ALERTS") === "on" && after?.needs_attention && !conv.needs_attention) {
    await alertStaff(waId, name, preview);
  }
}

async function handleConsentReply(db: SupabaseClient, conversationId: string, waId: string, consent: "yes" | "no") {
  const last10 = waId.slice(-10);
  const { error } = await db.from("profiles")
    .update(consentFields(consent === "yes", "whatsapp")).ilike("phone", `%${last10}`);
  if (error) console.error("save consent:", error.message);

  const text = consent === "yes"
    ? "¡Listo! 💕 Te enviaremos nuestras promociones y novedades. Si en algún momento no quieres recibirlas, responde BAJA."
    : "Entendido, no te enviaremos promociones. Si cambias de opinión, escríbenos. Seguimos a tu orden para tus citas. 💕";
  let waMessageId = "";
  let sendError = "";
  try {
    waMessageId = await sendWhatsAppMessage(waId, { type: "text", text: { body: text } });
  } catch (e) {
    sendError = (e as Error).message;
  }
  await db.from("wa_messages").insert({
    conversation_id: conversationId, direction: "out", sender: "system", body: text,
    wa_message_id: waMessageId || null, status: sendError ? "failed" : "sent", error: sendError || null,
  });
  await db.from("wa_conversations").update({ needs_attention: false }).eq("id", conversationId);
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

// A message staff sent from the WhatsApp Business app (coexistence echo).
async function handleEcho(db: SupabaseClient, e: Json) {
  const waId = String(e.to || "");
  if (!waId || !e.id) return;
  const conv = await getOrCreateConversation(db, waId, "");
  if (!conv) return;
  const row: Record<string, unknown> = {
    conversation_id: conv.id, direction: "out", sender: "staff", staff_user_id: null,
    body: messageText(e) || null, wa_message_id: e.id, status: "sent",
    created_at: e.timestamp ? new Date(Number(e.timestamp) * 1000).toISOString() : new Date().toISOString(),
  };
  if (MEDIA_TYPES.includes(e.type) && e[e.type]?.id) {
    row.media_type = e.type;
    row.media_filename = e[e.type].filename ?? null;
    try {
      const { bytes, mime } = await downloadWhatsAppMedia(e[e.type].id);
      const path = `outbound/${conv.id}/${e.id}.${extensionFor(mime, e[e.type].filename)}`;
      const { error } = await db.storage.from("wa-media").upload(path, bytes, { contentType: mime || undefined, upsert: true });
      if (error) throw error;
      row.media_path = path;
      row.media_mime = mime;
    } catch (err) {
      row.error = `media: ${(err as Error).message}`;
    }
  }
  const { error } = await db.from("wa_messages").insert(row);
  if (error) return; // duplicate delivery
  // Staff is handling this chat from the phone: the bot steps back.
  await db.from("wa_conversations").update({ bot_active: false, human_since: new Date().toISOString() })
    .eq("id", conv.id).eq("bot_active", true);
}

// Past chats sent once after connecting, in three shapes (as Meta actually
// sends them): value.history[].threads[].messages (texts, grouped by chat),
// value.messages (patients' recent photos/audio/video) and value.message_echoes
// (what the clinic sent). Saved without notifications; each chat keeps its
// unread / "por responder" state. Media is downloaded when Meta still has it
// (about the last 14 days).
const HISTORY_MEDIA_LABEL: Record<string, string> = { image: "📷 Foto", document: "📄 Documento", audio: "🎤 Audio", video: "🎥 Video", sticker: "Sticker" };
async function handleHistory(db: SupabaseClient, value: Json): Promise<number> {
  const business = String(value.metadata?.display_phone_number || "").replace(/\D/g, "");
  const byChat = new Map<string, Json[]>(); // customer wa_id → messages
  const add = (waId: string, m: Json) => {
    const id = String(waId || "").replace(/\D/g, "");
    if (!id || id === business || !m?.id) return;
    if (!byChat.has(id)) byChat.set(id, []);
    byChat.get(id)!.push(m);
  };
  for (const chunk of value.history ?? []) {
    for (const thread of chunk.threads ?? []) for (const m of thread.messages ?? []) add(thread.id || thread.context?.wa_id, m);
  }
  for (const m of value.messages ?? []) add(String(m.from || "").replace(/\D/g, "") === business ? m.to : m.from, m);
  for (const e of value.message_echoes ?? []) add(e.to, { ...e, from: business });

  let saved = 0;
  for (const [waId, messages] of byChat) {
    const conv = await getOrCreateConversation(db, waId, "");
    if (!conv) continue;
    const { data: before } = await db.from("wa_conversations").select("unread_count, needs_attention").eq("id", conv.id).single();
    const rows = [];
    for (const m of messages) {
      const fromBusiness = String(m.from || "").replace(/\D/g, "") === business;
      const isMedia = MEDIA_TYPES.includes(m.type);
      const row: Record<string, unknown> = {
        conversation_id: conv.id,
        direction: fromBusiness ? "out" : "in",
        sender: fromBusiness ? "staff" : "patient",
        body: (isMedia ? (m[m.type]?.caption ?? "") : messageText(m)) || null,
        wa_message_id: m.id,
        status: fromBusiness ? "sent" : "received",
        created_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
      };
      if (isMedia && m[m.type]?.id) {
        row.media_type = m.type;
        row.media_filename = m[m.type].filename ?? null;
        try {
          const { bytes, mime } = await downloadWhatsAppMedia(m[m.type].id);
          const path = `history/${conv.id}/${String(m.id).replace(/[^\w-]/g, "_")}.${extensionFor(mime, m[m.type].filename)}`;
          const { error } = await db.storage.from("wa-media").upload(path, bytes, { contentType: mime || undefined, upsert: true });
          if (error) throw error;
          row.media_path = path;
          row.media_mime = mime;
        } catch (_) {
          row.body = [`[${HISTORY_MEDIA_LABEL[m.type] || "Archivo"} del historial]`, row.body].filter(Boolean).join(" ");
        }
      }
      rows.push(row);
    }
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await db.from("wa_messages").upsert(rows.slice(i, i + 400), { onConflict: "wa_message_id", ignoreDuplicates: true });
      if (error) console.error("history save:", error.message); else saved += rows.slice(i, i + 400).length;
    }
    await restoreConversationSummary(db, conv.id, before);
  }
  return saved;
}

// The insert trigger treats every old message as new; put the summary back.
async function restoreConversationSummary(db: SupabaseClient, conversationId: string, before: Json) {
  const { data: last } = await db.from("wa_messages").select("body, media_type, direction, created_at")
    .eq("conversation_id", conversationId).neq("sender", "system").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: lastIn } = await db.from("wa_messages").select("created_at")
    .eq("conversation_id", conversationId).eq("direction", "in").order("created_at", { ascending: false }).limit(1).maybeSingle();
  await db.from("wa_conversations").update({
    unread_count: before?.unread_count ?? 0,
    needs_attention: before?.needs_attention ?? false,
    last_message_at: last?.created_at ?? null,
    last_message_preview: String(last?.body || HISTORY_MEDIA_LABEL[String(last?.media_type)] || "").slice(0, 120),
    last_message_direction: last?.direction ?? null,
    last_inbound_at: lastIn?.created_at ?? null,
    last_activity_at: last?.created_at ?? null,
  }).eq("id", conversationId);
}

// Contact names from the WhatsApp Business app, for chats that exist.
async function handleContactSync(db: SupabaseClient, value: Json): Promise<number> {
  let updated = 0;
  for (const item of value.state_sync ?? []) {
    const c = item.contact ?? {};
    const waId = String(c.phone_number || "").replace(/\D/g, "");
    const name = String(c.full_name || c.first_name || "").trim();
    if (!waId || !name || item.action === "remove") continue;
    const { data } = await db.from("wa_conversations").update({ profile_name: name }).eq("phone", waId).is("patient_id", null).select("id");
    updated += data?.length ?? 0;
  }
  return updated;
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
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const signatureOk = await validWebhookSignature(raw, req.headers.get("x-hub-signature-256"));
  const urlKey = Deno.env.get("WHATSAPP_WEBHOOK_KEY") ?? "";
  const keyOk = !!urlKey && url.searchParams.get("k") === urlKey;
  if (!signatureOk && !keyOk) {
    await saveDiagnostic(db, { signature_ok: false, key_ok: false, has_signature_header: !!req.headers.get("x-hub-signature-256"), bytes: raw.length });
    return new Response("invalid signature", { status: 401 });
  }
  const reprocessing = keyOk && req.headers.get("x-reprocess") === "1";

  const diag: Record<string, unknown> = { signature_ok: signatureOk, key_ok: keyOk, reprocessing, fields: [], messages: 0, statuses: 0 };
  try {
    const payload = JSON.parse(raw);
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        (diag.fields as string[]).push(String(change.field));
        diag.phone_number_id = value.metadata?.phone_number_id ?? diag.phone_number_id;
        diag.messages = Number(diag.messages) + (value.messages ?? []).length;
        diag.statuses = Number(diag.statuses) + (value.statuses ?? []).length;
        diag.waba_id = entry.id ?? diag.waba_id;
        const field = String(change.field);
        if (field !== "messages" && !reprocessing) await saveRaw(db, field, entry.id, value);
        if (field === "smb_message_echoes") {
          for (const e of value.message_echoes ?? []) await handleEcho(db, e);
          diag.echoes = Number(diag.echoes || 0) + (value.message_echoes ?? []).length;
        } else if (field === "history") {
          diag.history_saved = Number(diag.history_saved || 0) + await handleHistory(db, value);
        } else if (field === "smb_app_state_sync") {
          diag.contacts_named = Number(diag.contacts_named || 0) + await handleContactSync(db, value);
        }
        if (field === "messages") {
          for (const m of value.messages ?? []) await handleMessage(db, m, value.contacts ?? []);
          for (const s of value.statuses ?? []) await handleStatus(db, s);
        }
      }
    }
  } catch (e) {
    // Still answer 200: a non-2xx makes Meta retry the same payload for days.
    console.error("whatsapp-webhook:", (e as Error).message);
    diag.error = (e as Error).message;
  }
  await saveDiagnostic(db, diag);
  return new Response("ok", { status: 200 });
});

// Untouched copy of a coexistence/unknown payload (private bucket), so it can
// be re-processed: whatsapp-diagnose ?reprocess=raw/<field>/<file>.
async function saveRaw(db: SupabaseClient, field: string, entryId: unknown, value: Json) {
  try {
    const at = new Date().toISOString();
    const name = `raw/${field.replace(/[^\w-]/g, "_")}/${at}-${crypto.randomUUID().slice(0, 8)}.json`;
    await db.storage.from("wa-media").upload(name,
      new Blob([JSON.stringify({ field, entry_id: entryId, value })], { type: "application/json" }), { upsert: true });
  } catch (_) { /* never break the webhook */ }
}

// Technical trace of each call (never message content), read by
// whatsapp-diagnose while the connection is being set up.
async function saveDiagnostic(db: SupabaseClient, info: Record<string, unknown>) {
  try {
    const at = new Date().toISOString();
    await db.storage.from("wa-media").upload(`diag/webhook-${at}.json`,
      new Blob([JSON.stringify({ at, ...info })], { type: "application/json" }), { upsert: true });
  } catch (_) { /* diagnostics must never break the webhook */ }
}
