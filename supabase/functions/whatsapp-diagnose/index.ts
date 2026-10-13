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
    },
  };
  const graph = async (path: string, method = "GET") => {
    const r = await fetch(`${c.graph}/${path}`, { method, headers: { Authorization: `Bearer ${c.token}` } });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j?.error?.message ?? `HTTP ${r.status}`, code: j?.error?.code };
  };

  out.phone_number = await graph(`${c.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type`);
  const url = new URL(req.url);
  const waba = url.searchParams.get("waba");
  if (waba) {
    if (url.searchParams.get("subscribe") === "1") out.subscribe_result = await graph(`${waba}/subscribed_apps`, "POST");
    const subs = await graph(`${waba}/subscribed_apps`);
    out.waba_subscribed_apps = Array.isArray(subs?.data)
      ? subs.data.map((a: { whatsapp_business_api_data?: { name?: string; id?: string } }) => a.whatsapp_business_api_data?.name ?? a.whatsapp_business_api_data?.id)
      : subs;
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
