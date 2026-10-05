import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Public online booking (agendar.html). Two ways in:
//  - New patient: only the Step 1 basics (name, phone, email, DOB, sex). Creates
//    the portal account exactly like create-patient-account (synthetic email as
//    the auth identifier, phone digits as the password) but with no intake yet —
//    the patient finishes it later from the portal, or the admin does in clinic.
//  - Existing patient: signed in on the page (their phone + password), so the
//    request carries their session token and `use_session: true`.
// Either way the slot is taken through book_appointment_slot(), which re-checks
// it's free under a lock, and the appointment is created already confirmed.
// The WhatsApp assistant will book through this same function later.

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

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function onlyDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

// Must match create-patient-account and index.html.
function syntheticEmail(phoneDigits: string): string {
  return `${phoneDigits}@patients.piel-spa.internal`;
}

// Same ids/labels as TREATMENT_OPTIONS in dashboard.html and agendar.html.
// (filler_dissolution is visit-history only, not bookable.)
const BOOKABLE_TREATMENTS: Record<string, { en: string; es: string }> = {
  general_consultation: { en: "General Consultation", es: "Consulta General" },
  upper_face_rejuvenation: { en: "Upper Face Rejuvenation", es: "Rejuvenecimiento de la Parte Superior" },
  masseter_reduction_bruxism: { en: "Masseter Reduction (Bruxism)", es: "Reducción del Masetero (Bruxismo)" },
  gummy_smile_correction: { en: "Gummy Smile Correction", es: "Corrección de Sonrisa Gingival" },
  nasal_profiling: { en: "Nasal Profiling", es: "Perfilado Nasal" },
  hyperhidrosis_treatment: { en: "Hyperhidrosis Treatment", es: "Tratamiento de Hiperhidrosis" },
  lip_augmentation: { en: "Lip Augmentation", es: "Aumento de Labios" },
  facial_harmonization: { en: "Facial Harmonization", es: "Armonización Facial" },
  jawline_masculinization: { en: "Jawline Masculinization", es: "Masculinización de la Mandíbula" },
  facial_feminization: { en: "Facial Feminization", es: "Feminización Facial" },
  sculptra: { en: "Sculptra (Poly-L-Lactic Acid)", es: "Sculptra (Acido Polilactico)" },
  radiesse: { en: "Radiesse (Calcium Hydroxylapatite)", es: "Radiesse (Hidroxiapatita de Calcio)" },
  exosomes_therapy_direct_injection: { en: "Exosomes Therapy (Direct Injection)", es: "Terapia con Exosomas (Inyección Directa)" },
  microneedling_exosomes: { en: "Microneedling + Exosomes", es: "Microneedling + Exosomas" },
  salmon_pdrn_direct_injection: { en: "Salmon PDRN (Direct Injection)", es: "Salmon PDRN (Inyección Directa)" },
  microneedling_salmon_pdrn: { en: "Microneedling + Salmon PDRN", es: "Microneedling + Salmon PDRN" },
  nctf_skin_boosting: { en: "NCTF Skin Boosting", es: "Impulso de la Piel con NCTF" },
  fractional_co2_laser_resurfacing: { en: "Fractional CO2 Laser Resurfacing", es: "Resurfacing con Láser CO2 Fraccionado" },
  facial_cleansing: { en: "Facial Cleansing", es: "Limpieza Facial" },
};

// A patient can hold at most this many upcoming appointments — keeps the public
// form from being used to fill the agenda.
const MAX_UPCOMING_PER_PATIENT = 3;

function formatDateLong(isoDate: string, lang: "es" | "en"): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return d.toLocaleDateString(lang === "es" ? "es-ES" : "en-US", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

function formatTime12h(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function emailShell(bannerText: string, bannerBg: string, bannerColor: string, body: string, contactEmail: string) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
      <div style="background:#FDFBFC; padding: 24px 32px; text-align: center; border-bottom: 1px solid #EDE1E7;">
        <img src="https://piel-spa.com/images/logo.png" alt="Piel Spa" style="max-width:220px; width:100%; height:auto; display:inline-block;">
      </div>
      <div style="background:${bannerBg}; padding: 16px 32px; text-align:center; border-bottom: 1px solid #EDE1E7;">
        <p style="margin:0; font-size:13px; text-transform:uppercase; letter-spacing:2px; color:${bannerColor}; font-weight:bold;">${bannerText}</p>
      </div>
      <div style="background:#fff; padding: 32px;">${body}</div>
      <div style="background:#FBF0F3; padding:20px 32px; text-align:center; border-top:1px solid #EDE1E7;">
        <p style="margin:0; font-size:11px; color:#888; line-height:1.8;">
          Piel Spa LLC<br>
          <a href="https://piel-spa.com" style="color:#B76E88; text-decoration:none;">www.piel-spa.com</a> &nbsp;·&nbsp;
          <a href="mailto:${contactEmail}" style="color:#B76E88; text-decoration:none;">${contactEmail}</a>
        </p>
      </div>
    </div>
  `;
}

function renderWelcomeEmail(input: { firstName: string; phoneDigits: string; contactEmail: string }) {
  const body = `
    <p style="font-size:16px; margin-top:0;">Hola <strong>${escapeHtml(input.firstName)}</strong>,</p>
    <p style="font-size:14px; color:#444; line-height:1.6;">
      Al agendar tu cita creamos tu cuenta en el Portal del Paciente de
      <a href="https://piel-spa.com" style="color:#B76E88;">piel-spa.com</a>.
    </p>
    <div style="background:#FBF0F3; border:1px solid #EDE1E7; border-radius:8px; padding:16px 20px; margin:20px 0; text-align:center;">
      <p style="margin:0 0 10px; font-size:13px; color:#333; line-height:1.5;">
        Tu número de teléfono <strong>(sin el código de país)</strong> es a la vez tu usuario y tu contraseña:
      </p>
      <p style="margin:0; font-size:22px; font-weight:bold; letter-spacing:1px; color:#B76E88;">${escapeHtml(input.phoneDigits)}</p>
    </div>
    <p style="font-size:14px; color:#444; line-height:1.6;">
      <strong>Antes de tu cita</strong>, entra al portal y completa tu historia clínica (toma unos 5 minutos).
      Si no alcanzas, la terminamos juntos en la consulta.
    </p>
    <p style="text-align:center; margin:24px 0;">
      <a href="https://piel-spa.com" style="background:#B76E88; color:#fff; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:12px; letter-spacing:2px; text-transform:uppercase; font-weight:bold;">Completar mi historia</a>
    </p>
    <p style="font-size:13px; color:#666; line-height:1.6;">
      Welcome! We created your Patient Portal account when you booked. Your phone number (without the country code)
      is both your username and your password. Please log in and complete your health history before your visit —
      if you can't, we'll finish it together at the clinic.
    </p>
  `;
  return emailShell("Bienvenido(a) a Piel Spa &nbsp;·&nbsp; Welcome to Piel Spa", "#FBF0F3", "#B76E88", body, input.contactEmail);
}

function renderConfirmationEmail(input: {
  firstName: string; date: string; time: string; treatmentsEs: string[]; treatmentsEn: string[];
  intakeComplete: boolean; contactEmail: string;
}) {
  const rows = [
    `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Fecha / Date</td><td style="padding:6px 0; font-size:13px; font-weight:bold;">${escapeHtml(formatDateLong(input.date, "es"))}<br><span style="font-weight:normal; color:#666;">${escapeHtml(formatDateLong(input.date, "en"))}</span></td></tr>`,
    `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Hora / Time</td><td style="padding:6px 0; font-size:13px; font-weight:bold;">${escapeHtml(formatTime12h(input.time))}</td></tr>`,
    `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px; vertical-align:top;">Servicios / Services</td><td style="padding:6px 0; font-size:13px;">${input.treatmentsEs.map(escapeHtml).join(", ")}</td></tr>`,
  ].join("");
  const intakeNote = input.intakeComplete ? "" : `
    <div style="background:#FBF0F3; border-left:4px solid #B76E88; padding:12px 16px; margin:16px 0; border-radius:4px;">
      <p style="margin:0; font-size:13px; color:#2A2330;">
        📋 Tu historia clínica está pendiente. Complétala en <a href="https://piel-spa.com" style="color:#B76E88;">piel-spa.com</a> → Portal del Paciente antes de tu cita.<br>
        <em style="color:#666;">Your health history is pending — please complete it in the Patient Portal before your visit.</em>
      </p>
    </div>`;
  const body = `
    <p style="font-size:16px; margin-top:0;">Hola <strong>${escapeHtml(input.firstName)}</strong>,</p>
    <p style="margin:8px 0; color:#444; line-height:1.7;">
      Su cita está confirmada. Por favor llegue 15 minutos antes, con la cara limpia y el menor maquillaje posible.
      Si no puede asistir, avísenos con anticipación — el tiempo de todos es importante.
    </p>
    <p style="margin:8px 0; color:#666; font-style:italic; line-height:1.7;">
      Your appointment is confirmed. Please arrive 15 minutes early, with a clean face and as little makeup as possible.
      If you can't make it, please let us know in advance.
    </p>
    <table style="width:100%; border-collapse:collapse; margin:20px 0;">${rows}</table>
    ${intakeNote}
    <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:12px 16px; margin-top:20px;">
      <p style="margin:0; font-size:12px; color:#92400E;">
        📧 Si este correo llegó a spam, márcalo como "No es spam" para recibir tus recordatorios.<br>
        <em>If this landed in spam, mark it as "Not spam" so you get your reminders.</em>
      </p>
    </div>
  `;
  return emailShell("Cita confirmada &nbsp;·&nbsp; Appointment confirmed", "#D1FAE5", "#065F46", body, input.contactEmail);
}

function renderStaffAlertEmail(input: {
  patientName: string; phone: string; email: string; date: string; time: string; treatments: string[];
  isNew: boolean; intakeComplete: boolean;
}) {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px; vertical-align:top;">${label}</td><td style="padding:6px 0; font-size:13px;">${value}</td></tr>`;
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
      <div style="background: #2A2330; padding: 20px 32px;">
        <h1 style="margin:0; color:#B76E88; font-family: Georgia, serif; font-size:18px; letter-spacing:3px;">PIEL SPA · NUEVA CITA EN LÍNEA</h1>
      </div>
      <div style="background:#fff; padding: 28px 32px;">
        <p style="margin-top:0; font-size:15px;"><strong>Cita agendada y confirmada desde la web.</strong></p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          ${row("Paciente", `<strong>${escapeHtml(input.patientName)}</strong> ${input.isNew ? "(nuevo)" : ""}`)}
          ${row("Teléfono", escapeHtml(input.phone))}
          ${row("Email", escapeHtml(input.email))}
          ${row("Fecha", `<strong>${escapeHtml(formatDateLong(input.date, "es"))}</strong>`)}
          ${row("Hora", `<strong>${escapeHtml(formatTime12h(input.time))}</strong>`)}
          ${row("Servicios", input.treatments.map(escapeHtml).join(", "))}
          ${row("Historia clínica", input.intakeComplete ? "Completa" : "⚠️ Incompleta — completar en la consulta si el paciente no la termina")}
        </table>
      </div>
    </div>
  `;
}

async function sendEmail(resendApiKey: string, from: string, to: string[], subject: string, html: string, replyTo?: string) {
  const payload: Record<string, unknown> = { from, to, subject, html };
  if (replyTo) payload.reply_to = replyTo;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Resend error: ${await resp.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromRaw = Deno.env.get("FROM_EMAIL") ?? "noreply@piel-spa.com";
  const staffEmail = Deno.env.get("BOOKING_ALERT_EMAIL") ?? "";
  const contactEmail = "info@piel-spa.com";
  const fromEmail = `Piel Spa <${fromRaw}>`;

  if (!supabaseUrl || !serviceRole) return jsonResponse({ error: "Missing required env vars" }, 500);
  const adminClient = createClient(supabaseUrl, serviceRole);

  try {
    const body = await req.json();

    // Honeypot: a hidden field real people never fill in.
    if (String(body?.website || "").trim()) return jsonResponse({ ok: true });

    const date = String(body?.date || "").trim();
    const time = String(body?.time || "").trim().substring(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return jsonResponse({ error: "invalid_slot" }, 400);
    }

    const treatmentIds: string[] = (Array.isArray(body?.treatments) ? body.treatments : [])
      .map((id: unknown) => String(id))
      .filter((id: string, i: number, all: string[]) => BOOKABLE_TREATMENTS[id] && all.indexOf(id) === i);
    if (!treatmentIds.length) return jsonResponse({ error: "no_treatments" }, 400);

    // ---------- Who is booking ----------
    let patientId = "";
    let isNew = false;
    let firstName = "";
    let lastName = "";
    let patientEmail = "";
    let patientPhone = "";
    let phoneDigits = "";

    if (body?.use_session) {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: authData } = await adminClient.auth.getUser(token);
      const user = authData?.user;
      // Only patient logins (synthetic email) book this way — never staff accounts.
      if (!user || !String(user.email || "").endsWith("@patients.piel-spa.internal")) {
        return jsonResponse({ error: "not_signed_in" }, 401);
      }
      const { data: profile } = await adminClient
        .from("profiles").select("first_name, last_name, email, phone").eq("id", user.id).maybeSingle();
      patientId = user.id;
      firstName = String(profile?.first_name || "").trim();
      lastName = String(profile?.last_name || "").trim();
      patientEmail = String(profile?.email || "").trim();
      patientPhone = String(profile?.phone || "").trim();
    } else {
      const account = body?.new_patient ?? {};
      phoneDigits = onlyDigits(account.phone);
      const phoneCountryCode = String(account.phone_country_code || "+1").trim();
      firstName = String(account.first_name || "").trim();
      lastName = String(account.last_name || "").trim();
      patientEmail = String(account.email || "").trim();
      const dob = String(account.dob || "").trim();
      const sex = String(account.sex || "").trim();

      if (phoneDigits.length < 7 || phoneDigits.length > 15) return jsonResponse({ error: "invalid_phone" }, 400);
      if (!firstName || !lastName || !dob || !sex || !/^\S+@\S+\.\S+$/.test(patientEmail)) {
        return jsonResponse({ error: "missing_fields" }, 400);
      }

      const { data: phoneMatch } = await adminClient
        .from("profiles").select("id").ilike("phone", `%${phoneDigits}`).limit(1);
      if (phoneMatch?.length) return jsonResponse({ error: "phone_already_registered" }, 409);

      const { data: emailMatch } = await adminClient
        .from("profiles").select("id").ilike("email", patientEmail.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(1);
      if (emailMatch?.length) return jsonResponse({ error: "email_already_registered" }, 409);

      // Check the slot before creating anything, so a taken hour doesn't leave
      // an account behind. book_appointment_slot() checks again under a lock.
      const { data: freeNow } = await adminClient.rpc("available_slots", { p_from: date, p_to: date });
      if (!(freeNow || []).some((s: { slot_time: string }) => String(s.slot_time).substring(0, 5) === time)) {
        return jsonResponse({ error: "slot_not_available" }, 409);
      }

      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email: syntheticEmail(phoneDigits),
        password: phoneDigits,
        email_confirm: true,
        user_metadata: {
          first_name: firstName, last_name: lastName, dob, sex,
          phone: phoneDigits, phone_country_code: phoneCountryCode,
        },
      });
      if (createError || !created?.user) {
        const msg = (createError?.message || "").toLowerCase();
        const alreadyExists = msg.includes("already") || msg.includes("registered") || msg.includes("exists");
        return jsonResponse({ error: alreadyExists ? "phone_already_registered" : (createError?.message || "account_failed") }, alreadyExists ? 409 : 500);
      }

      patientId = created.user.id;
      patientPhone = `${phoneCountryCode}${phoneDigits}`;
      isNew = true;

      const { error: profileError } = await adminClient.from("profiles").upsert({
        id: patientId, first_name: firstName, last_name: lastName, dob, sex,
        phone: patientPhone, email: patientEmail, is_manual_patient: false,
      });
      if (profileError) {
        await adminClient.auth.admin.deleteUser(patientId);
        return jsonResponse({ error: `profile_failed: ${profileError.message}` }, 500);
      }
    }

    // ---------- Upcoming-appointments cap ----------
    if (!isNew) {
      const todayNy = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const { count } = await adminClient
        .from("appointments").select("id", { count: "exact", head: true })
        .eq("patient_id", patientId).neq("status", "cancelled").gte("appointment_date", todayNy);
      if ((count || 0) >= MAX_UPCOMING_PER_PATIENT) return jsonResponse({ error: "too_many_upcoming" }, 409);
    }

    // ---------- Take the slot ----------
    const labelsEn = treatmentIds.map((id) => BOOKABLE_TREATMENTS[id].en);
    const labelsEs = treatmentIds.map((id) => BOOKABLE_TREATMENTS[id].es);
    const { data: appointmentId, error: bookError } = await adminClient.rpc("book_appointment_slot", {
      p_patient_id: patientId,
      p_date: date,
      p_time: time,
      p_service_type: labelsEn.join(", "),
      p_service_ids: treatmentIds,
      p_status: "confirmed",
      p_booked_via: "web",
    });
    if (bookError) {
      if (isNew) {
        // Taken in the last second: don't leave a half-made new account behind.
        await adminClient.from("profiles").delete().eq("id", patientId);
        await adminClient.auth.admin.deleteUser(patientId);
      }
      const taken = (bookError.message || "").includes("slot_not_available");
      return jsonResponse({ error: taken ? "slot_not_available" : bookError.message }, taken ? 409 : 500);
    }

    const { data: admission } = await adminClient
      .from("admission_history").select("intake_completed_at").eq("patient_id", patientId).maybeSingle();
    const intakeComplete = !!admission?.intake_completed_at;

    // ---------- Emails (never fail the booking over an email) ----------
    if (resendApiKey) {
      const jobs: Promise<unknown>[] = [];
      if (patientEmail) {
        if (isNew) {
          jobs.push(sendEmail(resendApiKey, fromEmail, [patientEmail], "Tu cuenta en Piel Spa | Your Piel Spa account",
            renderWelcomeEmail({ firstName, phoneDigits, contactEmail }), staffEmail || undefined));
        }
        jobs.push(sendEmail(resendApiKey, fromEmail, [patientEmail], "Cita confirmada | Piel Spa",
          renderConfirmationEmail({ firstName, date, time, treatmentsEs: labelsEs, treatmentsEn: labelsEn, intakeComplete, contactEmail }),
          staffEmail || undefined));
      }
      if (staffEmail) {
        jobs.push(sendEmail(resendApiKey, fromEmail, [staffEmail], `🗓 Nueva cita en línea: ${firstName} ${lastName} · ${date} ${time}`,
          renderStaffAlertEmail({ patientName: `${firstName} ${lastName}`, phone: patientPhone, email: patientEmail, date, time, treatments: labelsEs, isNew, intakeComplete })));
      }
      const results = await Promise.allSettled(jobs);
      results.forEach((r) => { if (r.status === "rejected") console.error("book-appointment email:", r.reason); });
    }

    return jsonResponse({ ok: true, appointment_id: appointmentId, is_new: isNew, intake_complete: intakeComplete, date, time });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
