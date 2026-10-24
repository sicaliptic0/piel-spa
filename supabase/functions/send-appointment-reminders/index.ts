import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CLINIC_WHATSAPP, CORS_HEADERS, appointmentDetailsTable, clinicDate, clinicHour, emailConfig, emailShell,
  escapeHtml, formatTime12h, jsonResponse, sendEmail, treatmentLabels,
} from "../_shared/clinic.ts";
import { whatsappConnected } from "../_shared/whatsapp.ts";
import { sendTemplate } from "../_shared/sendTemplate.ts";
import { clinicPlaces, dayEs, placeFor } from "../_shared/appointmentText.ts";

// Called every hour by pg_cron (migration 20261005_appointment_reminders.sql).
// Between 10:00 and 20:59 New York time, for each of tomorrow's appointments
// that hasn't had a reminder:
//   - email with links to confirm or cancel (cita.html), when there's an email;
//   - WhatsApp template recordatorio_cita (buttons Confirmo asistencia /
//     Reprogramar / Cancelar cita, answered by whatsapp-webhook), when there's
//     a phone and the patient isn't marked "No contactar".
// Each appointment is reminded once, so extra calls do nothing.

const SEND_FROM_HOUR = 10;
const SEND_UNTIL_HOUR = 20;
// Booked this recently = they just got the confirmation email; skip the reminder.
const SKIP_IF_BOOKED_WITHIN_HOURS = 12;

function renderReminderEmail(input: { firstName: string; date: string; time: string; treatmentsEs: string[]; token: string }) {
  const link = (action: string) => `https://piel-spa.com/cita.html#t=${input.token}${action ? `&a=${action}` : ""}`;
  const waText = encodeURIComponent(`Hola, quisiera reprogramar mi cita del ${input.date} a las ${input.time}.`);
  const button = (href: string, label: string, bg: string, color: string, border: string) =>
    `<a href="${href}" style="display:inline-block; background:${bg}; color:${color}; border:1px solid ${border}; text-decoration:none; padding:12px 18px; border-radius:6px; font-size:12px; letter-spacing:1px; text-transform:uppercase; font-weight:bold; margin:4px;">${label}</a>`;
  const body = `
    <p style="font-size:16px; margin-top:0;">Hola <strong>${escapeHtml(input.firstName)}</strong>,</p>
    <p style="margin:8px 0; color:#444; line-height:1.7;">
      Te recordamos tu cita de <strong>mañana</strong> en Piel Spa. Por favor confírmanos si asistirás.
    </p>
    <p style="margin:8px 0; color:#666; font-style:italic; line-height:1.7;">
      This is a reminder of your appointment <strong>tomorrow</strong> at Piel Spa. Please let us know if you'll attend.
    </p>
    ${appointmentDetailsTable(input.date, input.time, input.treatmentsEs)}
    <div style="text-align:center; margin:24px 0;">
      ${button(link("confirm"), "✓ Confirmar / Confirm", "#B76E88", "#fff", "#B76E88")}
      ${button(`https://wa.me/${CLINIC_WHATSAPP}?text=${waText}`, "Reprogramar / Reschedule", "#fff", "#128C7E", "#25D366")}
      ${button(link("cancel"), "Cancelar / Cancel", "#fff", "#991B1B", "#FCA5A5")}
    </div>
    <p style="margin:8px 0; color:#444; line-height:1.7; font-size:13px;">
      Llega 15 minutos antes, con la cara limpia y el menor maquillaje posible.<br>
      <em style="color:#666;">Please arrive 15 minutes early, with a clean face and as little makeup as possible.</em>
    </p>
  `;
  return emailShell("Recordatorio de cita &nbsp;·&nbsp; Appointment reminder", "#FBF0F3", "#B76E88", body);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const { resendApiKey, from, staffEmail } = emailConfig();
  if (!supabaseUrl || !serviceRole || !resendApiKey) return jsonResponse({ error: "Missing required env vars" }, 500);
  const adminClient = createClient(supabaseUrl, serviceRole);

  const hour = clinicHour();
  if (hour < SEND_FROM_HOUR || hour > SEND_UNTIL_HOUR) return jsonResponse({ ok: true, skipped: "outside_hours", hour });

  const tomorrow = clinicDate(1);
  const { data: due, error } = await adminClient
    .from("appointments")
    .select("id, patient_id, appointment_date, appointment_time, service_type, service_type_ids, status, location, response_token, created_at, whatsapp_reminder_at, profiles(first_name, email, phone)")
    .eq("appointment_date", tomorrow)
    .is("reminder_sent_at", null)
    .neq("status", "cancelled");
  if (error) return jsonResponse({ error: error.message }, 500);

  const result = { sent: 0, whatsapp: 0, no_contact: 0, skipped_recent: 0, failed: 0 };
  const recentCutoff = Date.now() - SKIP_IF_BOOKED_WITHIN_HOURS * 3600000;
  const useWhatsApp = whatsappConnected();
  const places = await clinicPlaces(adminClient);
  const { data: flags } = await adminClient.from("patient_staff_flags").select("patient_id").eq("do_not_contact", true);
  const doNotContact = new Set((flags || []).map((f) => String(f.patient_id)));

  for (const appt of due || []) {
    // deno-lint-ignore no-explicit-any
    const profile = (Array.isArray(appt.profiles) ? appt.profiles[0] : appt.profiles) as any;
    const email = String(profile?.email || "").trim();
    const time = String(appt.appointment_time).substring(0, 5);
    const channels: string[] = [];
    let failed = false;
    let whatsappAt: string | null = null;

    if (appt.created_at && new Date(appt.created_at).getTime() > recentCutoff) {
      result.skipped_recent++;
      channels.push("skipped_recent");
    } else {
      if (email) {
        try {
          await sendEmail(resendApiKey, from, [email], "Recordatorio: tu cita es mañana | Piel Spa",
            renderReminderEmail({
              firstName: String(profile?.first_name || "").trim(),
              date: appt.appointment_date,
              time,
              treatmentsEs: treatmentLabels(appt.service_type_ids, appt.service_type, "es"),
              token: String(appt.response_token),
            }),
            staffEmail || undefined);
          channels.push("email");
          result.sent++;
        } catch (e) {
          console.error(`reminder email ${appt.id}:`, (e as Error).message);
          failed = true;
        }
      }
      // Skipped if the admin already sent it by hand from "Recordatorios de mañana".
      if (useWhatsApp && profile?.phone && !appt.whatsapp_reminder_at && !doNotContact.has(String(appt.patient_id))) {
        const firstName = String(profile?.first_name || "").trim() || "paciente";
        const sent = await sendTemplate(adminClient, {
          template: "recordatorio_cita",
          params: [firstName, dayEs(appt.appointment_date), formatTime12h(time), placeFor(places, appt.location)],
          patientId: appt.patient_id,
          appointmentId: String(appt.id),
        });
        if (sent.ok) {
          channels.push("whatsapp");
          whatsappAt = new Date().toISOString();
          result.whatsapp++;
        } else {
          console.error(`reminder whatsapp ${appt.id}:`, sent.error, "detail" in sent ? sent.detail : "");
          failed = true;
        }
      }
      if (!channels.length && failed) {
        // Nothing went out: left unmarked, so the next hourly run tries again.
        result.failed++;
        continue;
      }
      if (!channels.length) { channels.push("none"); result.no_contact++; }
    }

    await adminClient.from("appointments")
      .update({ reminder_sent_at: new Date().toISOString(), reminder_channel: channels.join("+"), ...(whatsappAt ? { whatsapp_reminder_at: whatsappAt } : {}) })
      .eq("id", appt.id);
  }

  return jsonResponse({ ok: true, date: tomorrow, ...result });
});
