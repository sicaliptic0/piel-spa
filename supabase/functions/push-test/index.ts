import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, jsonResponse } from "../_shared/clinic.ts";
import { sendPushToStaff } from "../_shared/push.ts";

// "Probar aviso" in the admin: sends a test notification to the signed-in
// admin's own devices, so they can check the phone setup before WhatsApp is live.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: authData } = await db.auth.getUser(token);
  const user = authData?.user;
  if (!user) return jsonResponse({ error: "not_signed_in" }, 401);
  const { data: role } = await db.from("staff_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (role?.role !== "admin") return jsonResponse({ error: "not_allowed" }, 403);

  const delivered = await sendPushToStaff(db, {
    title: "Piel Spa · Prueba",
    body: "✅ Los avisos funcionan en este dispositivo.",
    tag: "push-test",
    url: "/admin.html#mensajes",
  }, user.id);
  return jsonResponse({ ok: true, delivered });
});
