// Shared by the booking, reminder and appointment-response edge functions (and,
// later, the WhatsApp assistant): treatment catalog, date formatting, the email
// layout and the Resend call.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const CLINIC_TIME_ZONE = "America/New_York";
export const CONTACT_EMAIL = "info@piel-spa.com";
export const CLINIC_WHATSAPP = "19295613388";

// Same ids/labels as TREATMENT_OPTIONS in dashboard.html and agendar.html.
// `bookable: false` = shown in visit history only.
export const TREATMENTS: Record<string, { en: string; es: string; bookable?: false }> = {
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
  filler_dissolution: { en: "Filler Removal", es: "Disolución de Rellenos", bookable: false },
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

export function isBookableTreatment(id: string): boolean {
  return !!TREATMENTS[id] && TREATMENTS[id].bookable !== false;
}

// Labels for an appointment: from service_type_ids when present, else the
// free-text service_type the admin may have typed.
export function treatmentLabels(ids: unknown, fallback: unknown, lang: "es" | "en"): string[] {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter((id) => TREATMENTS[id]);
  if (list.length) return list.map((id) => TREATMENTS[id][lang]);
  const text = String(fallback ?? "").trim();
  return text ? [text] : [];
}

// "YYYY-MM-DD" in clinic time, `offsetDays` from today.
export function clinicDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: CLINIC_TIME_ZONE });
}

export function clinicHour(): number {
  return Number(new Date().toLocaleString("en-US", { timeZone: CLINIC_TIME_ZONE, hour: "numeric", hour12: false })) % 24;
}

export function formatDateLong(isoDate: string, lang: "es" | "en"): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return d.toLocaleDateString(lang === "es" ? "es-ES" : "en-US", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

export function formatTime12h(time: string): string {
  const [h, m] = String(time).split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function emailShell(bannerText: string, bannerBg: string, bannerColor: string, body: string) {
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
          <a href="mailto:${CONTACT_EMAIL}" style="color:#B76E88; text-decoration:none;">${CONTACT_EMAIL}</a>
        </p>
      </div>
    </div>
  `;
}

// Date / time / services rows used by the confirmation and reminder emails.
export function appointmentDetailsTable(date: string, time: string, treatmentsEs: string[]): string {
  return `
    <table style="width:100%; border-collapse:collapse; margin:20px 0;">
      <tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Fecha / Date</td><td style="padding:6px 0; font-size:13px; font-weight:bold;">${escapeHtml(formatDateLong(date, "es"))}<br><span style="font-weight:normal; color:#666;">${escapeHtml(formatDateLong(date, "en"))}</span></td></tr>
      <tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px;">Hora / Time</td><td style="padding:6px 0; font-size:13px; font-weight:bold;">${escapeHtml(formatTime12h(time))}</td></tr>
      ${treatmentsEs.length ? `<tr><td style="padding:6px 12px 6px 0; color:#888; font-size:13px; vertical-align:top;">Servicios / Services</td><td style="padding:6px 0; font-size:13px;">${treatmentsEs.map(escapeHtml).join(", ")}</td></tr>` : ""}
    </table>`;
}

export function emailConfig() {
  const fromRaw = Deno.env.get("FROM_EMAIL") ?? "noreply@piel-spa.com";
  return {
    resendApiKey: Deno.env.get("RESEND_API_KEY") ?? "",
    from: `Piel Spa <${fromRaw}>`,
    staffEmail: Deno.env.get("BOOKING_ALERT_EMAIL") ?? "",
  };
}

export async function sendEmail(resendApiKey: string, from: string, to: string[], subject: string, html: string, replyTo?: string) {
  const payload: Record<string, unknown> = { from, to, subject, html };
  if (replyTo) payload.reply_to = replyTo;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Resend error: ${await resp.text()}`);
}
