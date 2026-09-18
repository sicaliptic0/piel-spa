import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function onlyDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

// Lets the intake warn the patient on Module 1 — before they fill out the rest of the
// form — that their phone number is already registered, instead of only finding out
// at the very last step. Returns only a boolean, never any patient details, to keep
// this from being useful for enumerating who has an account beyond a yes/no per number.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) {
    return jsonResponse({ error: "Missing required env vars" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRole);

  try {
    const body = await req.json();
    const phoneDigits = onlyDigits(body?.phone);
    if (phoneDigits.length < 7) return jsonResponse({ available: true });

    const { data: profiles, error } = await adminClient
      .from("profiles")
      .select("id")
      .ilike("phone", `%${phoneDigits}`)
      .limit(1);

    if (error) return jsonResponse({ available: true }); // fail open — never block signup over a lookup error
    return jsonResponse({ available: !profiles?.length });
  } catch (_error) {
    return jsonResponse({ available: true });
  }
});
