import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CORS_HEADERS, clinicDate, emailConfig, escapeHtml, formatDateLong, formatTime12h, jsonResponse, sendEmail,
  treatmentLabels,
} from "../_shared/clinic.ts";

// Behind cita.html — the page the reminder email links to. The link carries the
// appointment's response_token (a random id), so the patient can see the
// appointment and confirm or cancel it without signing in.
//   { token, action: "view" | "confirm" | "cancel" }
// Cancelling frees the slot and emails the clinic.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function renderStaffCancelEmail(input: { name: string; phone: string; date: string; time: string; treatments: string[] }) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
      <div style="background: #2A2330; padding: 20px 32px;">
        <h1 style="margin:0; color:#B76E88; font-family: Georgia, serif; font-size:18px; letter-spacing:3px;">PIEL SPA · CITA CANCELADA</h1>
      </div>
      <div style="background:#fff; padding: 28px 32px; font-size:14px; line-height:1.7;">
        <p style="margin-top:0;"><strong>${escapeHtml(input.name)}</strong> canceló su cita desde el recordatorio. El horario quedó libre.</p>
        <p>📅 ${escapeHtml(formatDateLong(input.date, "es"))} · ${escapeHtml(formatTime12h(input.time))}<br>
           💆 ${input.treatments.map(escapeHtml).join(", ") || "—"}<br>
           📞 ${escapeHtml(input.phone || "—")}</p>
      </div>
    </div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return jsonResponse({ error: "Missing required env vars" }, 500);
  const adminClient = createClient(supabaseUrl, serviceRole);

  try {
    const body = await req.json();
    const token = String(body?.token || "").trim();
    const action = String(body?.action || "view");
    if (!UUID_RE.test(token)) return jsonResponse({ error: "not_found" }, 404);

    const { data: appt } = await adminClient
      .from("appointments")
      .select("id, appointment_date, appointment_time, service_type, service_type_ids, status, patient_confirmed_at, patient_cancelled_at, profiles(first_name, last_name, phone)")
      .eq("response_token", token)
      .maybeSingle();
    if (!appt) return jsonResponse({ error: "not_found" }, 404);

    // deno-lint-ignore no-explicit-any
    const profile = (Array.isArray(appt.profiles) ? appt.profiles[0] : appt.profiles) as any;
    const time = String(appt.appointment_time).substring(0, 5);
    const isPast = appt.appointment_date < clinicDate(0);
    const isCancelled = appt.status === "cancelled";

    const view = () => ({
      ok: true,
      first_name: String(profile?.first_name || "").trim(),
      date: appt.appointment_date,
      time,
      treatments_es: treatmentLabels(appt.service_type_ids, appt.service_type, "es"),
      treatments_en: treatmentLabels(appt.service_type_ids, appt.service_type, "en"),
      status: appt.status,
      confirmed: !!appt.patient_confirmed_at,
      is_past: isPast,
    });

    if (action === "view") return jsonResponse(view());
    if (action !== "confirm" && action !== "cancel") return jsonResponse({ error: "invalid_action" }, 400);
    if (isPast) return jsonResponse({ error: "past" }, 409);
    if (isCancelled) return jsonResponse({ error: "cancelled" }, 409);

    if (action === "confirm") {
      const confirmedAt = appt.patient_confirmed_at || new Date().toISOString();
      await adminClient.from("appointments").update({ patient_confirmed_at: confirmedAt }).eq("id", appt.id);
      appt.patient_confirmed_at = confirmedAt;
      return jsonResponse(view());
    }

    // cancel
    await adminClient.from("appointments")
      .update({ status: "cancelled", patient_cancelled_at: new Date().toISOString() })
      .eq("id", appt.id);
    appt.status = "cancelled";

    const { resendApiKey, from, staffEmail } = emailConfig();
    if (resendApiKey && staffEmail) {
      try {
        await sendEmail(resendApiKey, from, [staffEmail],
          `❌ Cita cancelada: ${profile?.first_name || ""} ${profile?.last_name || ""} · ${appt.appointment_date} ${time}`,
          renderStaffCancelEmail({
            name: `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim(),
            phone: String(profile?.phone || ""),
            date: appt.appointment_date,
            time,
            treatments: treatmentLabels(appt.service_type_ids, appt.service_type, "es"),
          }));
      } catch (e) {
        console.error("cancel alert email:", (e as Error).message);
      }
    }
    return jsonResponse(view());
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
