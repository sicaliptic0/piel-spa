import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, jsonResponse } from "../_shared/clinic.ts";
import { consentFields } from "../_shared/marketing.ts";
import { verifyUnsubscribeToken } from "../_shared/unsubscribe.ts";

// Behind baja.html — the "darse de baja" link in announcement emails.
//   { t: "<patientId>.<signature>", confirm?: true }
// Without confirm it only says whether the link is valid (mail scanners open
// links on their own); with confirm it saves "no promotions" on the profile.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const patientId = await verifyUnsubscribeToken(String(body?.t || ""));
    if (!patientId) return jsonResponse({ error: "invalid_link" }, 400);
    if (!body?.confirm) return jsonResponse({ ok: true, valid: true });

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await db.from("profiles").update({ ...consentFields(false, "staff"), marketing_consent_source: "email" }).eq("id", patientId);
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true, unsubscribed: true });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
