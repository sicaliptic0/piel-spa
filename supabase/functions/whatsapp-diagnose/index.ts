import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { whatsappConfig } from "../_shared/whatsapp.ts";

// Setup check for the WhatsApp connection. Needs the x-diag-key header
// (DIAG_KEY secret). Reports only technical status — never tokens, message
// text or patient data:
//   - which WhatsApp secrets are set
//   - whether the token works for the configured phone number
//   - whether the WhatsApp Business Account is subscribed to this app
//     (?waba=<id>), which Meta requires to deliver real messages
//   - message/conversation counts and the last webhook calls

Deno.serve(async (req) => {
  const key = Deno.env.get("DIAG_KEY");
  if (!key || req.headers.get("x-diag-key") !== key) return new Response("forbidden", { status: 403 });

  const c = whatsappConfig();
  const out: Record<string, unknown> = {
    secrets: {
      WHATSAPP_TOKEN: !!c.token, WHATSAPP_PHONE_NUMBER_ID: !!c.phoneNumberId,
      WHATSAPP_APP_SECRET: !!c.appSecret, WHATSAPP_VERIFY_TOKEN: !!c.verifyToken,
      WHATSAPP_PIN_is_6_digits: /^\d{6}$/.test(Deno.env.get("WHATSAPP_PIN") ?? ""),
    },
  };
  const graph = async (path: string, method = "GET") => {
    const r = await fetch(`${c.graph}/${path}`, { method, headers: { Authorization: `Bearer ${c.token}` } });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j?.error?.message ?? `HTTP ${r.status}`, code: j?.error?.code };
  };

  // What kind of token is stored (a token may inspect itself): SYSTEM_USER + expires 0 = permanent.
  const dbg = await graph(`debug_token?input_token=${encodeURIComponent(c.token)}`);
  out.token = dbg?.data
    ? {
      type: dbg.data.type, app: dbg.data.application, valid: dbg.data.is_valid,
      expires: dbg.data.expires_at ? new Date(dbg.data.expires_at * 1000).toISOString() : "never",
      scopes: dbg.data.scopes,
    }
    : dbg;
  const url = new URL(req.url);
  // ?phone=<id> checks (and registers) a number other than the configured one —
  // used while moving the clinic's real number to the Cloud API.
  const phoneId = url.searchParams.get("phone") || c.phoneNumberId;
  if (url.searchParams.get("register") === "1") {
    // Registering sets the number's two-step PIN, kept as the WHATSAPP_PIN secret.
    const pin = Deno.env.get("WHATSAPP_PIN") ?? "";
    if (!/^\d{6}$/.test(pin)) {
      out.register_result = { error: "WHATSAPP_PIN secret missing or not 6 digits" };
    } else {
      const r = await fetch(`${c.graph}/${phoneId}/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      });
      const j = await r.json().catch(() => ({}));
      out.register_result = r.ok ? j : { error: j?.error?.message ?? `HTTP ${r.status}`, code: j?.error?.code, details: j?.error?.error_data?.details };
    }
  }
  out.phone_number = await graph(`${phoneId}?fields=display_phone_number,verified_name,name_status,quality_rating,code_verification_status,platform_type,status`);
  const waba = url.searchParams.get("waba");
  if (waba) {
    if (url.searchParams.get("subscribe") === "1") out.subscribe_result = await graph(`${waba}/subscribed_apps`, "POST");
    const subs = await graph(`${waba}/subscribed_apps`);
    out.waba_subscribed_apps = Array.isArray(subs?.data)
      ? subs.data.map((a: { whatsapp_business_api_data?: { name?: string; id?: string } }) => a.whatsapp_business_api_data?.name ?? a.whatsapp_business_api_data?.id)
      : subs;
  }

  // ?send_to=<wa_id>[&phone=<id>]: sends a short test text with OUR token —
  // tells whether this system can send through a number connected by a partner
  // (needs the recipient to have written in the last 24 h).
  const sendTo = (url.searchParams.get("send_to") || "").replace(/\D/g, "");
  if (sendTo) {
    const r = await fetch(`${c.graph}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: sendTo, type: "text", text: { body: "✅ Prueba de conexión del sistema Piel Spa." } }),
    });
    const j = await r.json().catch(() => ({}));
    out.send_test = r.ok ? { ok: true, id: j?.messages?.[0]?.id } : { error: j?.error?.message, code: j?.error?.code, details: j?.error?.error_data?.details };
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Saved coexistence payloads (wa-media/raw/<field>/…): list them, and
  // ?reprocess=raw/<field>[/<file>] re-sends them through whatsapp-webhook.
  const raws: Record<string, number> = {};
  for (const field of ["history", "smb_message_echoes", "smb_app_state_sync", "account_update"]) {
    const { data } = await db.storage.from("wa-media").list(`raw/${field}`, { limit: 1000 });
    if (data?.length) raws[field] = data.length;
  }
  out.raw_payloads = raws;
  const reprocess = url.searchParams.get("reprocess") || "";
  if (/^raw\/[\w-]+(\/[\w.:-]+\.json)?$/.test(reprocess)) {
    const key = Deno.env.get("WHATSAPP_WEBHOOK_KEY") ?? "";
    const isFile = reprocess.endsWith(".json");
    const folder = isFile ? reprocess.slice(0, reprocess.lastIndexOf("/")) : reprocess;
    const names = isFile ? [reprocess.slice(reprocess.lastIndexOf("/") + 1)]
      : ((await db.storage.from("wa-media").list(folder, { limit: 1000, sortBy: { column: "name", order: "asc" } })).data ?? []).map((f) => f.name);
    const results = [];
    for (const name of names) {
      const { data } = await db.storage.from("wa-media").download(`${folder}/${name}`);
      if (!data) { results.push({ name, error: "not found" }); continue; }
      const saved = JSON.parse(await data.text());
      const body = { object: "whatsapp_business_account", entry: [{ id: saved.entry_id, changes: [{ field: saved.field, value: saved.value }] }] };
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-webhook?k=${encodeURIComponent(key)}`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-reprocess": "1" }, body: JSON.stringify(body),
      });
      results.push({ name, status: r.status });
    }
    out.reprocess_results = results;
  }

  const { count: conversations } = await db.from("wa_conversations").select("id", { count: "exact", head: true });
  const { count: messages } = await db.from("wa_messages").select("id", { count: "exact", head: true });
  out.counts = { conversations, messages };

  const { data: files } = await db.storage.from("wa-media").list("diag", { limit: 10, sortBy: { column: "name", order: "desc" } });
  const calls = [];
  for (const f of files ?? []) {
    const { data } = await db.storage.from("wa-media").download(`diag/${f.name}`);
    if (data) calls.push(JSON.parse(await data.text()));
  }
  out.last_webhook_calls = calls;

  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
