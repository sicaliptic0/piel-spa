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

// Supabase's "Phone" auth provider requires a configured SMS gateway (e.g. Twilio)
// just to be enabled in the dashboard, even though we never send any SMS/OTP — so
// login instead uses a deterministic, never-shown-to-the-user synthetic email as the
// actual auth identifier, with the phone digits as the password. The patient's real
// email (for the welcome message / password recovery) is stored separately in
// `profiles.email`, never as the auth identifier.
function syntheticEmail(phoneDigits: string): string {
  return `${phoneDigits}@patients.piel-spa.internal`;
}

function renderWelcomeEmail(input: { firstName: string; phoneDigits: string; contactEmail: string }) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
      <div style="background:#FDFBFC; padding: 24px 32px; text-align: center; border-bottom: 1px solid #EDE1E7;">
        <img src="https://piel-spa.com/images/logo.png" alt="Piel Spa" style="max-width:220px; width:100%; height:auto; display:inline-block;">
      </div>
      <div style="background:#FBF0F3; padding: 16px 32px; text-align:center; border-bottom: 1px solid #EDE1E7;">
        <p style="margin:0; font-size:13px; text-transform:uppercase; letter-spacing:2px; color:#B76E88; font-weight:bold;">
          Bienvenido(a) a tu Portal de Paciente &nbsp;·&nbsp; Welcome to Your Patient Portal
        </p>
      </div>
      <div style="background:#fff; padding: 32px;">
        <p style="font-size:16px; margin-top:0;">Hola <strong>${escapeHtml(input.firstName)}</strong>,</p>
        <p style="font-size:14px; color:#444; line-height:1.6;">
          Tu cuenta y tu historia clínica han sido creadas exitosamente. Ya puedes iniciar sesión en el Portal del
          Paciente en <a href="https://piel-spa.com" style="color:#B76E88;">piel-spa.com</a>.
        </p>
        <div style="background:#FBF0F3; border:1px solid #EDE1E7; border-radius:8px; padding:16px 20px; margin:20px 0; text-align:center;">
          <p style="margin:0 0 10px; font-size:13px; color:#333; line-height:1.5;">
            Tu número de teléfono <strong>(sin el código de país)</strong> es a la vez tu usuario y tu contraseña para iniciar sesión:
          </p>
          <p style="margin:0; font-size:22px; font-weight:bold; letter-spacing:1px; color:#B76E88;">${escapeHtml(input.phoneDigits)}</p>
          <p style="margin:10px 0 0; font-size:12px; color:#888;">Usa este mismo número en ambos campos: Teléfono y Contraseña.</p>
        </div>
        <p style="font-size:13px; color:#666; line-height:1.6;">
          Por tu seguridad, te recomendamos cambiar tu contraseña después de tu primer inicio de sesión (opcional,
          desde tu perfil dentro del portal).
        </p>
        <p style="font-size:14px; color:#444; line-height:1.6; margin-top:16px;">
          Welcome! Your account and clinical intake have been created. You can log in to the Patient Portal using
          your phone number as both your username and initial password. We recommend changing your password after
          your first login (optional).
        </p>
      </div>
      <div style="background:#FBF0F3; padding:20px 32px; text-align:center; border-top:1px solid #EDE1E7;">
        <p style="margin:0; font-size:11px; color:#888; line-height:1.8;">
          Piel Spa LLC<br>
          <a href="https://piel-spa.com" style="color:#B76E88; text-decoration:none;">www.piel-spa.com</a> &nbsp;·&nbsp;
          <a href="mailto:${input.contactEmail}" style="color:#B76E88; text-decoration:none;">${input.contactEmail}</a>
        </p>
      </div>
    </div>
  `;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromRaw = Deno.env.get("FROM_EMAIL") ?? "noreply@piel-spa.com";
  const contactEmail = "info@piel-spa.com";
  const fromEmail = `Piel Spa <${fromRaw}>`;

  if (!supabaseUrl || !serviceRole) {
    return jsonResponse({ error: "Missing required env vars" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRole);

  try {
    const body = await req.json();
    const account = body?.account ?? {};
    const intake = body?.intake ?? {};

    const phoneDigits = onlyDigits(account.phone);
    const phoneCountryCode = String(account.phone_country_code || "+1").trim();
    const firstName = String(account.first_name || "").trim();
    const lastName = String(account.last_name || "").trim();
    const email = String(account.email || "").trim();
    const dob = String(account.dob || "").trim();
    const sex = String(account.sex || "").trim();
    const preferredContactMethods = Array.isArray(account.preferred_contact_methods) ? account.preferred_contact_methods : [];

    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return jsonResponse({ error: "Invalid phone number" }, 400);
    }
    if (!firstName || !lastName || !dob || !sex || !email) {
      return jsonResponse({ error: "Missing required account fields" }, 400);
    }

    // The phone digits double as the initial password (product decision — patients can
    // change it later from the portal). The auth identifier is a synthetic email (see
    // syntheticEmail()) rather than the phone field itself or the patient's real email.
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: syntheticEmail(phoneDigits),
      password: phoneDigits,
      email_confirm: true,
      user_metadata: {
        first_name: firstName,
        last_name: lastName,
        dob,
        sex,
        phone: phoneDigits,
        phone_country_code: phoneCountryCode,
        preferred_contact_methods: preferredContactMethods,
      },
    });

    if (createError || !created?.user) {
      const msg = (createError?.message || "").toLowerCase();
      const alreadyExists = msg.includes("already") || msg.includes("registered") || msg.includes("exists");
      return jsonResponse({ error: alreadyExists ? "phone_already_registered" : (createError?.message || "Could not create account") }, alreadyExists ? 409 : 500);
    }

    const userId = created.user.id;

    // profiles.phone stores the full dialable number (with country code) so staff can
    // actually reach the patient — distinct from the bare digits used for login/password.
    const { error: profileError } = await adminClient.from("profiles").upsert({
      id: userId,
      first_name: firstName,
      last_name: lastName,
      dob,
      sex,
      phone: `${phoneCountryCode}${phoneDigits}`,
      email,
      is_manual_patient: false,
    });
    if (profileError) {
      return jsonResponse({ error: `Account created but profile save failed: ${profileError.message}` }, 500);
    }

    const admissionPayload = {
      ...intake,
      patient_id: userId,
      intake_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    delete (admissionPayload as Record<string, unknown>).id;

    const { error: admissionError } = await adminClient.from("admission_history").insert([admissionPayload]);
    if (admissionError) {
      return jsonResponse({ error: `Account created but intake save failed: ${admissionError.message}` }, 500);
    }

    if (resendApiKey) {
      try {
        const html = renderWelcomeEmail({ firstName, phoneDigits, contactEmail });
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromEmail, to: [email], subject: "Bienvenido(a) a Piel Spa | Welcome to Piel Spa", html }),
        });
      } catch (_emailErr) {
        // Account + intake already saved successfully — a failed welcome email shouldn't fail the signup.
      }
    }

    return jsonResponse({ ok: true, user_id: userId });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
