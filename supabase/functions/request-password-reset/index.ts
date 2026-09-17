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

// Must match create-patient-account's syntheticEmail() exactly — that's the actual
// auth.users identifier for this account, distinct from the patient's real email
// (stored only in profiles.email, used purely as the delivery address below).
function syntheticEmail(phoneDigits: string): string {
  return `${phoneDigits}@patients.piel-spa.internal`;
}

function renderResetEmail(input: { firstName: string; actionLink: string; contactEmail: string }) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #333;">
      <div style="background:#FDFBFC; padding: 24px 32px; text-align: center; border-bottom: 1px solid #EDE1E7;">
        <img src="https://piel-spa.com/images/logo.png" alt="Piel Spa" style="max-width:220px; width:100%; height:auto; display:inline-block;">
      </div>
      <div style="background:#FBF0F3; padding: 16px 32px; text-align:center; border-bottom: 1px solid #EDE1E7;">
        <p style="margin:0; font-size:13px; text-transform:uppercase; letter-spacing:2px; color:#B76E88; font-weight:bold;">
          Restablecer Contraseña &nbsp;·&nbsp; Reset Your Password
        </p>
      </div>
      <div style="background:#fff; padding: 32px; text-align:center;">
        <p style="font-size:16px; margin-top:0; text-align:left;">Hola <strong>${escapeHtml(input.firstName)}</strong>,</p>
        <p style="font-size:14px; color:#444; line-height:1.6; text-align:left;">
          Recibimos una solicitud para restablecer la contraseña de tu Portal del Paciente. Haz clic en el siguiente
          botón para elegir una nueva contraseña. Si tú no solicitaste esto, puedes ignorar este correo.
        </p>
        <a href="${input.actionLink}" style="display:inline-block; margin:20px 0; padding:14px 32px; background:#B76E88; color:#fff; text-decoration:none; text-transform:uppercase; letter-spacing:1px; font-size:12px; border-radius:6px;">
          Restablecer Contraseña / Reset Password
        </a>
        <p style="font-size:12px; color:#888; line-height:1.6; text-align:left;">
          If you did not request this, you can safely ignore this email.
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

  if (!supabaseUrl || !serviceRole || !resendApiKey) {
    return jsonResponse({ error: "Missing required env vars" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRole);

  // Always responds { ok: true } on the happy path AND on "not found" so the
  // UI can't be used to enumerate which phone numbers are registered.
  try {
    const body = await req.json();
    const phoneDigits = onlyDigits(body?.phone);
    const redirectTo = String(body?.redirect_to || "https://piel-spa.com/reset-password.html");

    if (!phoneDigits) return jsonResponse({ error: "Missing phone" }, 400);

    // profiles.phone stores the full dialable number (with country code), but login
    // (and this form) only ever deals in the bare digits — match by suffix instead of
    // exact equality so "9175551234" still finds a stored "+19175551234".
    const { data: profiles } = await adminClient
      .from("profiles")
      .select("id, email, first_name")
      .ilike("phone", `%${phoneDigits}`)
      .limit(1);
    const profile = profiles?.[0];

    if (!profile?.email) {
      return jsonResponse({ ok: true });
    }

    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: "recovery",
      email: syntheticEmail(phoneDigits),
      options: { redirectTo },
    });

    if (linkError || !linkData?.properties?.action_link) {
      console.error("generateLink error:", linkError?.message);
      return jsonResponse({ ok: true });
    }

    const html = renderResetEmail({
      firstName: profile.first_name || "",
      actionLink: linkData.properties.action_link,
      contactEmail,
    });

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromEmail, to: [profile.email], subject: "Restablecer tu contraseña | Reset your password", html }),
    });

    return jsonResponse({ ok: true });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: true });
  }
});
