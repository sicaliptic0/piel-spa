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
  // send_to=latest → whoever wrote to the clinic most recently (last hour).
  let sendTo = (url.searchParams.get("send_to") || "").replace(/\D/g, "");
  if (url.searchParams.get("send_to") === "latest") {
    const db0 = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: latest } = await db0.from("wa_conversations").select("phone, last_inbound_at").not("last_inbound_at", "is", null)
      .order("last_inbound_at", { ascending: false }).limit(1).maybeSingle();
    sendTo = latest && Date.now() - new Date(latest.last_inbound_at).getTime() < 3600000 ? latest.phone : "";
    out.send_to_latest = latest ? { phone_last4: String(latest.phone).slice(-4), wrote_at: latest.last_inbound_at } : null;
  }
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
  // ?peek=raw/<field>: the SHAPE of the first saved payloads (keys and types;
  // text replaced by its length, numbers/ids cut to the last 4 characters).
  const peek = url.searchParams.get("peek") || "";
  if (/^raw\/[\w-]+$/.test(peek)) {
    const KEEP = new Set(["type", "field", "status", "phase", "chunk_order", "progress", "messaging_product", "action", "event"]);
    const shape = (v: unknown, key = ""): unknown => {
      if (Array.isArray(v)) return v.length ? [shape(v[0], key), `…${v.length} items`] : [];
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, k)]));
      if (typeof v === "string") return KEEP.has(key) ? v : (/^[\d.+]+$/.test(v) || /id$/i.test(key) || ["from", "to", "timestamp"].includes(key) ? `…${v.slice(-4)}` : `<text ${v.length}>`);
      return v;
    };
    const { data: files } = await db.storage.from("wa-media").list(peek, { limit: 3, sortBy: { column: "name", order: "asc" } });
    const shapes = [];
    for (const f of files ?? []) {
      const { data } = await db.storage.from("wa-media").download(`${peek}/${f.name}`);
      if (data) shapes.push({ file: f.name, shape: shape(JSON.parse(await data.text())) });
    }
    out.peek = shapes;
  }
  // ?stats=raw/history: counts across ALL saved history payloads (no content):
  // message keys, types, how many came from the clinic's own number, and the
  // keys of those — to know who each clinic message was sent to.
  if (url.searchParams.get("stats") === "raw/history") {
    const { data: files } = await db.storage.from("wa-media").list("raw/history", { limit: 1000 });
    const keys: Record<string, number> = {}, clinicKeys: Record<string, number> = {}, types: Record<string, number> = {};
    let total = 0, fromClinic = 0, files_ = 0;
    const clinicSample: unknown[] = [];
    for (const f of files ?? []) {
      const { data } = await db.storage.from("wa-media").download(`raw/history/${f.name}`);
      if (!data) continue;
      files_++;
      const v = JSON.parse(await data.text()).value ?? {};
      const business = String(v.metadata?.display_phone_number || "").replace(/\D/g, "");
      for (const m of v.messages ?? []) {
        total++;
        types[m.type] = (types[m.type] || 0) + 1;
        Object.keys(m).forEach((k) => keys[k] = (keys[k] || 0) + 1);
        if (String(m.from || "").replace(/\D/g, "") === business) {
          fromClinic++;
          Object.keys(m).forEach((k) => clinicKeys[k] = (clinicKeys[k] || 0) + 1);
          if (clinicSample.length < 2) clinicSample.push(Object.fromEntries(Object.entries(m).map(([k, x]) => [k, typeof x === "object" ? Object.keys(x as object) : `…${String(x).slice(-4)}`])));
        }
      }
    }
    out.history_stats = { files: files_, total, fromClinic, types, keys, clinicKeys, clinicSample };
    // Payloads without value.messages: their top-level keys and the shape of one.
    const otherKeys: Record<string, number> = {};
    let otherShape: unknown = null;
    const KEEP = new Set(["type", "status", "phase", "chunk_order", "progress", "messaging_product"]);
    const shape = (v: unknown, key = ""): unknown => {
      if (Array.isArray(v)) return v.length ? [shape(v[0], key), `…${v.length} items`] : [];
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, k)]));
      if (typeof v === "string") return KEEP.has(key) ? v : (/^[\d.+]+$/.test(v) || /id$/i.test(key) || ["from", "to", "timestamp"].includes(key) ? `…${v.slice(-4)}` : `<text ${v.length}>`);
      return v;
    };
    for (const f of files ?? []) {
      const { data } = await db.storage.from("wa-media").download(`raw/history/${f.name}`);
      if (!data) continue;
      const v = JSON.parse(await data.text()).value ?? {};
      if ((v.messages ?? []).length) continue;
      Object.keys(v).forEach((k) => otherKeys[k] = (otherKeys[k] || 0) + 1);
      if (!otherShape && v.history) otherShape = shape(v);
    }
    out.history_other = { keys: otherKeys, shape: otherShape };
  }
  const reprocess = url.searchParams.get("reprocess") || "";
  if (/^raw\/[\w-]+(\/[\w.:-]+\.json)?$/.test(reprocess)) {
    const key = Deno.env.get("WHATSAPP_WEBHOOK_KEY") ?? "";
    const isFile = reprocess.endsWith(".json");
    const folder = isFile ? reprocess.slice(0, reprocess.lastIndexOf("/")) : reprocess;
    const names = isFile ? [reprocess.slice(reprocess.lastIndexOf("/") + 1)]
      : ((await db.storage.from("wa-media").list(folder, { limit: 1000, sortBy: { column: "name", order: "asc" } })).data ?? []).map((f) => f.name)
          .slice(Number(url.searchParams.get("offset") || 0), Number(url.searchParams.get("offset") || 0) + Number(url.searchParams.get("limit") || 1000));
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

  // ?repair_history=<ISO time of connecting>: chats whose last patient message
  // is older than that only got history — clear their unread / "por responder"
  // and recompute the last-message summary from the saved messages.
  const repairCutoff = url.searchParams.get("repair_history") || "";
  if (/^\d{4}-\d{2}-\d{2}T/.test(repairCutoff)) {
    const { data: convs } = await db.from("wa_conversations").select("id");
    let cleared = 0, recomputed = 0;
    for (const conv of convs ?? []) {
      const { data: last } = await db.from("wa_messages").select("body, media_type, direction, created_at")
        .eq("conversation_id", conv.id).neq("sender", "system").order("created_at", { ascending: false }).limit(1).maybeSingle();
      const { data: lastIn } = await db.from("wa_messages").select("created_at")
        .eq("conversation_id", conv.id).eq("direction", "in").order("created_at", { ascending: false }).limit(1).maybeSingle();
      const onlyHistory = !lastIn || lastIn.created_at < repairCutoff;
      const labels: Record<string, string> = { image: "📷 Foto", document: "📄 Documento", audio: "🎤 Audio", video: "🎥 Video", sticker: "Sticker" };
      await db.from("wa_conversations").update({
        ...(onlyHistory ? { unread_count: 0, needs_attention: false } : {}),
        last_message_at: last?.created_at ?? null,
        last_message_preview: String(last?.body || labels[String(last?.media_type)] || "").slice(0, 120),
        last_message_direction: last?.direction ?? null,
        last_inbound_at: lastIn?.created_at ?? null,
        last_activity_at: last?.created_at ?? null,
      }).eq("id", conv.id);
      recomputed++;
      if (onlyHistory) cleared++;
    }
    out.repair = { recomputed, cleared };
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
