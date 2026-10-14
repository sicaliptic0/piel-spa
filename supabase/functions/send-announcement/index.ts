import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, emailConfig, emailShell, escapeHtml, jsonResponse } from "../_shared/clinic.ts";
import { unsubscribeLink } from "../_shared/unsubscribe.ts";

// Pacientes → "📣 Anuncio" → "Enviar por correo". Admins only.
//   { announcement_id, patient_ids: [...] }
// Re-checks each patient server-side: skips "No contactar", patients who said
// no to promotions, patients without email and those already emailed this
// announcement. "{nombre}" in the text becomes the first name. Every email has
// a personal "darse de baja" link (baja.html). Sent through Resend's batch API.

const BATCH = 100;

function textToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#B76E88;">$1</a>')
    .split(/\n{2,}/).map((p) => `<p style="font-size:15px; color:#333; line-height:1.7; margin:0 0 14px;">${p.replace(/\n/g, "<br>")}</p>`).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { resendApiKey, from, staffEmail } = emailConfig();

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: authData } = await db.auth.getUser(token);
    const user = authData?.user;
    if (!user) return jsonResponse({ error: "not_signed_in" }, 401);
    const { data: role } = await db.from("staff_roles").select("role").eq("user_id", user.id).maybeSingle();
    if (role?.role !== "admin") return jsonResponse({ error: "not_allowed" }, 403);
    if (!resendApiKey) return jsonResponse({ error: "email_not_configured" }, 503);

    const body = await req.json();
    const announcementId = String(body?.announcement_id || "");
    const ids: string[] = (Array.isArray(body?.patient_ids) ? body.patient_ids : []).map(String);
    const { data: ann } = await db.from("announcements").select("id, body").eq("id", announcementId).maybeSingle();
    if (!ann) return jsonResponse({ error: "announcement_not_found" }, 404);
    if (!ids.length) return jsonResponse({ ok: true, sent: 0, skipped: 0 });

    const [{ data: profiles }, { data: flags }, { data: already }] = await Promise.all([
      db.from("profiles").select("id, first_name, email, marketing_consent").in("id", ids),
      db.from("patient_staff_flags").select("patient_id").eq("do_not_contact", true).in("patient_id", ids),
      db.from("announcement_recipients").select("patient_id").eq("announcement_id", ann.id).eq("channel", "email").in("patient_id", ids),
    ]);
    const blocked = new Set((flags ?? []).map((f) => f.patient_id));
    const done = new Set((already ?? []).map((r) => r.patient_id));
    const targets = (profiles ?? []).filter((p) =>
      !blocked.has(p.id) && p.marketing_consent !== "no" && !done.has(p.id) && /^\S+@\S+\.\S+$/.test(String(p.email || "").trim()));

    let sent = 0;
    const failed: string[] = [];
    for (let i = 0; i < targets.length; i += BATCH) {
      const chunk = targets.slice(i, i + BATCH);
      const emails = await Promise.all(chunk.map(async (p) => {
        const firstName = String(p.first_name || "").trim();
        const text = ann.body.replace(/\{nombre\}/gi, firstName || "").replace(/ ,/g, ",");
        const unsubscribe = await unsubscribeLink(p.id);
        const html = emailShell("Piel Spa", "#FBF0F3", "#B76E88", `${textToHtml(text)}
          <p style="font-size:11px; color:#999; margin-top:28px; border-top:1px solid #EDE1E7; padding-top:12px;">
            Recibes este correo porque eres paciente de Piel Spa. ¿No quieres recibir más avisos como este?
            <a href="${unsubscribe}" style="color:#999;">Darte de baja</a>.
          </p>`);
        return {
          from, to: [String(p.email).trim()], subject: text.split("\n").find((l) => l.trim())?.slice(0, 90) || "Piel Spa",
          html, ...(staffEmail ? { reply_to: staffEmail } : {}),
          headers: { "List-Unsubscribe": `<${unsubscribe}>` },
        };
      }));
      const resp = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(emails),
      });
      if (!resp.ok) { failed.push(`${chunk.length}: ${(await resp.text()).slice(0, 200)}`); continue; }
      sent += chunk.length;
      await db.from("announcement_recipients").upsert(
        chunk.map((p) => ({ announcement_id: ann.id, patient_id: p.id, channel: "email" })),
        { onConflict: "announcement_id,patient_id,channel", ignoreDuplicates: true },
      );
    }

    return jsonResponse({ ok: true, sent, skipped: ids.length - targets.length, failed });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
