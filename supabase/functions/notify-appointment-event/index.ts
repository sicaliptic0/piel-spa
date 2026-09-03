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

type EventType = "new_booking" | "appointment_status_update";

const statusLabelEs: Record<string, string> = {
  pending: "en espera",
  confirmed: "confirmada",
  cancelled: "cancelada",
  modified: "modificada",
};

// Pre-set clinic messages per status
const presetMessage: Record<string, { en: string; es: string }> = {
  confirmed: {
    en: "Your appointment is confirmed. Please make sure to arrive 15 minutes early. If you are unable to attend, please notify us in advance — everyone's time is important. Come with a clean face and as little makeup as possible. For any questions, contact us by email or phone. Please verify the date and time again and add it to your calendar.",
    es: "Su cita está confirmada. Por favor asegúrese de llegar 15 minutos antes. De no poder acudir, avise con anticipación — el tiempo de todos es importante. Acuda con la cara limpia y el menor maquillaje posible. Cualquier duda comuníquese con nosotros a través del correo electrónico o vía telefónica. Verifique nuevamente la fecha y hora y agéndela en su calendario.",
  },
  modified: {
    en: "Your appointment has been modified. Please make sure to arrive 15 minutes early. If you are unable to attend, please notify us in advance — everyone's time is important. Come with a clean face and as little makeup as possible. For any questions, contact us by email or phone. Please verify the new date and time and add it to your calendar.",
    es: "Su cita ha sido modificada. Por favor asegúrese de llegar 15 minutos antes. De no poder acudir, avise con anticipación — el tiempo de todos es importante. Acuda con la cara limpia y el menor maquillaje posible. Cualquier duda comuníquese con nosotros a través del correo electrónico o vía telefónica. Verifique la nueva fecha y hora y agéndela en su calendario.",
  },
  cancelled: {
    en: "Your appointment has been cancelled. Please contact us if you have any questions or would like to reschedule.",
    es: "Su cita ha sido cancelada. Comuníquese con nosotros si tiene alguna duda o desea reagendar.",
  },
};

function renderStatusEmail(input: {
  patientName: string;
  status: string;
  appointmentDate: string;
  appointmentTime: string;
  treatments: string[];
  adminInstructions: string;
  contactEmail: string;
}) {
  const labelEs = statusLabelEs[input.status] || input.status;
  const preset = presetMessage[input.status];
  const presetHtmlEn = preset
    ? `<p style="margin:16px 0; color:#444; line-height:1.7;">${preset.en}</p>`
    : "";
  const presetHtmlEs = preset
    ? `<p style="margin:8px 0; color:#666; font-style:italic; line-height:1.7;">${preset.es}</p>`
    : "";

  const adminNote = input.adminInstructions
    ? `<div style="background:#FBF0F3; border-left:4px solid #B76E88; padding:12px 16px; margin:16px 0; border-radius:4px;">
        <p style="margin:0; font-size:13px; color:#2A2330;"><strong>Note from our team:</strong> ${input.adminInstructions}</p>
       </div>`
    : "";

  const detailsRows = [
    input.appointmentDate ? `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Date / Fecha</td><td style="padding:6px 0; font-size:13px; font-weight:bold;">${input.appointmentDate}</td></tr>` : "",
    input.appointmentTime ? `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Time / Hora</td><td style="padding:6px 0; font-size:13px; font-weight:bold;">${input.appointmentTime.substring(0, 5)}</td></tr>` : "",
    input.treatments.length ? `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px; vertical-align:top;">Treatments / Servicios</td><td style="padding:6px 0; font-size:13px;">${input.treatments.join(", ")}</td></tr>` : "",
  ].filter(Boolean).join("");

  const statusColor: Record<string, string> = {
    confirmed: "#065F46",
    modified: "#9A3412",
    cancelled: "#991B1B",
    pending: "#92400E",
  };
  const headerBg: Record<string, string> = {
    confirmed: "#D1FAE5",
    modified: "#FFEDD5",
    cancelled: "#FEE2E2",
    pending: "#FEF3C7",
  };

  const color = statusColor[input.status] || "#333";
  const bg = headerBg[input.status] || "#FBF0F3";

  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
      <!-- Header -->
      <div style="background: #2A2330; padding: 28px 32px; text-align: center;">
        <h1 style="margin:0; color:#B76E88; font-family: Georgia, serif; font-size:22px; letter-spacing:4px; text-transform:uppercase;">Piel Spa</h1>
      </div>

      <!-- Status banner -->
      <div style="background:${bg}; padding: 16px 32px; text-align:center; border-bottom: 1px solid #EDE1E7;">
        <p style="margin:0; font-size:13px; text-transform:uppercase; letter-spacing:2px; color:${color}; font-weight:bold;">
          Cita ${labelEs} &nbsp;·&nbsp; Appointment ${input.status}
        </p>
      </div>

      <!-- Body -->
      <div style="background:#fff; padding: 32px;">
        <p style="font-size:16px; margin-top:0;">Hola <strong>${input.patientName}</strong>,</p>

        ${presetHtmlEs}
        ${presetHtmlEn}
        ${adminNote}

        <!-- Details table -->
        ${detailsRows ? `<table style="width:100%; border-collapse:collapse; margin:20px 0;">${detailsRows}</table>` : ""}

        <!-- Spam note -->
        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:12px 16px; margin-top:20px;">
          <p style="margin:0; font-size:12px; color:#92400E;">
            📧 <strong>Tip:</strong> If future emails from us land in spam, please mark them as "Not Spam" to ensure you receive all updates.<br>
            <em>Si futuros correos llegan a spam, márcalos como "No es spam" para recibir todas las actualizaciones.</em>
          </p>
        </div>
      </div>

      <!-- Footer -->
      <div style="background:#FBF0F3; padding:20px 32px; text-align:center; border-top:1px solid #EDE1E7;">
        <p style="margin:0; font-size:11px; color:#888; line-height:1.8;">
          Piel Spa LLC<br>
          <a href="mailto:${input.contactEmail}" style="color:#B76E88; text-decoration:none;">${input.contactEmail}</a>
        </p>
      </div>
    </div>
  `;
}

function renderStaffAlertEmail(input: {
  patientName: string;
  patientEmail: string;
  appointmentDate: string;
  appointmentTime: string;
  treatments: string[];
  status: string;
}) {
  const detailsRows = [
    `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Patient</td><td style="padding:6px 0; font-size:13px;"><strong>${input.patientName}</strong></td></tr>`,
    `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Email</td><td style="padding:6px 0; font-size:13px;">${input.patientEmail}</td></tr>`,
    input.appointmentDate ? `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Date</td><td style="padding:6px 0; font-size:13px; font-weight:bold;">${input.appointmentDate}</td></tr>` : "",
    input.appointmentTime ? `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Time</td><td style="padding:6px 0; font-size:13px; font-weight:bold;">${input.appointmentTime.substring(0, 5)}</td></tr>` : "",
    input.treatments.length ? `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px; vertical-align:top;">Services</td><td style="padding:6px 0; font-size:13px;">${input.treatments.join(", ")}</td></tr>` : "",
  ].filter(Boolean).join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
      <div style="background: #2A2330; padding: 20px 32px;">
        <h1 style="margin:0; color:#B76E88; font-family: Georgia, serif; font-size:18px; letter-spacing:3px;">PIEL SPA ADMIN ALERT</h1>
      </div>
      <div style="background:#fff; padding: 28px 32px;">
        <p style="margin-top:0; font-size:15px;"><strong>New appointment request received.</strong></p>
        <p style="color:#666; font-size:13px;">Please review and confirm/modify/cancel from the admin dashboard.</p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">${detailsRows}</table>
      </div>
      <div style="background:#FBF0F3; padding:16px 32px; font-size:11px; color:#888; text-align:center; border-top:1px solid #EDE1E7;">Piel Spa Admin Notification</div>
    </div>
  `;
}

async function sendEmail(
  resendApiKey: string,
  fromEmail: string,
  to: string[],
  subject: string,
  html: string,
  replyTo?: string,
) {
  const payload: Record<string, unknown> = { from: fromEmail, to, subject, html };
  if (replyTo) payload.reply_to = replyTo;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Resend error: ${txt}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromRaw = Deno.env.get("FROM_EMAIL") ?? "noreply@piel-spa.com";
  const staffEmail = Deno.env.get("BOOKING_ALERT_EMAIL") ?? "";
  const contactEmail = "info@fsmedesthetics.com";

  // FROM with display name for better deliverability
  const fromEmail = `Piel Spa <${fromRaw}>`;

  if (!supabaseUrl || !serviceRole || !resendApiKey) {
    return jsonResponse({ error: "Missing required env vars" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRole);

  try {
    const body = await req.json();
    const eventType = String(body?.event_type || "") as EventType;
    const patientId = String(body?.patient_id || "");
    const patientName = String(body?.patient_name || "Patient");
    const appointmentDate = String(body?.appointment_date || "");
    const appointmentTime = String(body?.appointment_time || "");
    const status = String(body?.status || "pending").toLowerCase();
    const adminInstructions = String(body?.instructions || "").trim();
    const treatments: string[] = Array.isArray(body?.treatments) ? body.treatments : [];
    const patientEmailFromBody = String(body?.patient_email || "").trim();

    if (!eventType || !patientId) return jsonResponse({ error: "Missing event_type or patient_id" }, 400);

    // ── NEW BOOKING ─────────────────────────────────────────────────────────
    if (eventType === "new_booking") {
      if (!staffEmail) {
        return jsonResponse({ error: "BOOKING_ALERT_EMAIL is not configured" }, 500);
      }

      // 1. Alert to clinic staff
      const htmlStaff = renderStaffAlertEmail({
        patientName,
        patientEmail: patientEmailFromBody,
        appointmentDate,
        appointmentTime,
        treatments,
        status,
      });
      await sendEmail(
        resendApiKey,
        fromEmail,
        [staffEmail],
        "🗓 Nueva Solicitud de Cita | Piel Spa",
        htmlStaff,
      );

      // 2. Receipt to patient (if email provided)
      if (patientEmailFromBody) {
        const htmlPatient = renderStatusEmail({
          patientName,
          status: "pending",
          appointmentDate,
          appointmentTime,
          treatments,
          adminInstructions: "",
          contactEmail,
        });
        await sendEmail(
          resendApiKey,
          fromEmail,
          [patientEmailFromBody],
          "Solicitud de Cita Recibida | Piel Spa",
          htmlPatient,
          staffEmail, // reply-to goes to clinic
        );
      }
    }

    // ── STATUS UPDATE (confirmed / modified / cancelled) ─────────────────────
    if (eventType === "appointment_status_update") {
      // Resolve patient email: body takes priority, fallback to auth lookup
      let patientEmail = patientEmailFromBody;
      if (!patientEmail) {
        const { data: authUser, error: authErr } = await adminClient.auth.admin.getUserById(patientId);
        if (!authErr && authUser?.user?.email) {
          patientEmail = authUser.user.email;
        }
      }

      if (!patientEmail) {
        return jsonResponse({ error: "Could not resolve patient email" }, 400);
      }

      // Send status email ONLY to patient (no copy to clinic)
      const htmlPatient = renderStatusEmail({
        patientName,
        status,
        appointmentDate,
        appointmentTime,
        treatments,
        adminInstructions,
        contactEmail,
      });

      const statusLabel = statusLabelEs[status] || status;
      await sendEmail(
        resendApiKey,
        fromEmail,
        [patientEmail],
        `Su cita ha sido ${statusLabel} | Piel Spa`,
        htmlPatient,
        staffEmail || undefined,
      );
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
