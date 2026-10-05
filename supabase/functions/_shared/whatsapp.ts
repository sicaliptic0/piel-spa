// WhatsApp Cloud API (Meta) helpers, shared by whatsapp-send, whatsapp-webhook
// and, later, the reminders and the AI assistant.
//
// Secrets (Supabase → Edge Functions → Secrets), set once the number is
// connected in Meta:
//   WHATSAPP_TOKEN            permanent System User token
//   WHATSAPP_PHONE_NUMBER_ID  the number's id in Meta (not the phone itself)
//   WHATSAPP_APP_SECRET       the Meta app's secret, to verify webhook signatures
//   WHATSAPP_VERIFY_TOKEN     any random text, also typed in Meta's webhook setup
//   WHATSAPP_GRAPH_VERSION    optional, e.g. "v23.0"

export function whatsappConfig() {
  return {
    token: Deno.env.get("WHATSAPP_TOKEN") ?? "",
    phoneNumberId: Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "",
    appSecret: Deno.env.get("WHATSAPP_APP_SECRET") ?? "",
    verifyToken: Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "",
    graph: `https://graph.facebook.com/${Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v23.0"}`,
  };
}

export function whatsappConnected(): boolean {
  const c = whatsappConfig();
  return !!(c.token && c.phoneNumberId);
}

export function onlyDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

// profiles.phone may be "+19295550000" or bare US "9295550000"; WhatsApp ids
// are digits with country code. Returns the WhatsApp id or "".
export function toWhatsAppId(phone: unknown): string {
  let digits = onlyDigits(phone);
  if (digits.length === 10) digits = "1" + digits;
  return digits.length >= 11 ? digits : "";
}

// Send one message. `payload` is the type-specific part, e.g.
// { type: "text", text: { body } } or { type: "image", image: { link, caption } }.
export async function sendWhatsAppMessage(to: string, payload: Record<string, unknown>): Promise<string> {
  const c = whatsappConfig();
  const resp = await fetch(`${c.graph}/${c.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = data?.error;
    throw new Error(err ? `${err.code ?? ""} ${err.message ?? ""}`.trim() : `HTTP ${resp.status}`);
  }
  return String(data?.messages?.[0]?.id ?? "");
}

// Download a received photo/file from Meta (two steps: media id → url → bytes).
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const c = whatsappConfig();
  const meta = await fetch(`${c.graph}/${mediaId}`, { headers: { Authorization: `Bearer ${c.token}` } }).then((r) => r.json());
  if (!meta?.url) throw new Error(`media ${mediaId}: no url`);
  const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${c.token}` } });
  if (!file.ok) throw new Error(`media ${mediaId}: HTTP ${file.status}`);
  return { bytes: new Uint8Array(await file.arrayBuffer()), mime: String(meta.mime_type || file.headers.get("content-type") || "") };
}

// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body).
export async function validWebhookSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secret = whatsappConfig().appSecret;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "application/pdf": "pdf", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "video/mp4": "mp4", "video/3gpp": "3gp",
};
export function extensionFor(mime: string, filename?: string): string {
  const fromName = String(filename || "").split(".").pop();
  if (filename && fromName && fromName.length <= 5) return fromName.toLowerCase();
  return EXT_BY_MIME[String(mime).split(";")[0].trim()] ?? "bin";
}
