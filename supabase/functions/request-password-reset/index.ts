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

const PATIENT_LOGIN_DOMAIN = "@patients.piel-spa.internal";

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

  // deno-lint-ignore no-explicit-any
  const sendResetLink = async (profiles: any[], redirectTo: string, fromAdmin = false): Promise<{ sent_to?: string; reason?: string; detail?: string; staff?: boolean }> => {
    // A phone can have several profiles (a historic patient, or a staff member
    // with a separate patient account). The one that logs in by phone is the
    // account with the internal email, so that's the one whose password changes.
    const accounts: { email: string; profile: (typeof profiles)[number] }[] = [];
    for (const profile of profiles) {
      const { data } = await adminClient.auth.admin.getUserById(profile.id);
      if (data?.user?.email) accounts.push({ email: data.user.email, profile });
    }
    const account = accounts.find((a) => a.email.endsWith(PATIENT_LOGIN_DOMAIN)) ?? accounts[0];
    if (!account) return { reason: "no_login" };

    // An account with a real email isn't a phone login, so a new password here
    // wouldn't let its owner in by phone. Staff keep it that way, and their (admin)
    // password never changes from the patient form; an old patient account
    // becomes a phone login, keeping its id and history.
    let staff = false;
    if (!account.email.endsWith(PATIENT_LOGIN_DOMAIN)) {
      const { data: role } = await adminClient.from("staff_roles").select("role").eq("user_id", account.profile.id).maybeSingle();
      staff = !!role;
      if (staff && !fromAdmin) return { reason: "staff_account" };
      const digits = onlyDigits(account.profile.phone);
      const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
      if (!staff && national.length >= 7) {
        const phoneLogin = `${national}${PATIENT_LOGIN_DOMAIN}`;
        const { error: moveError } = await adminClient.auth.admin.updateUserById(account.profile.id, { email: phoneLogin, email_confirm: true });
        if (moveError) console.error("phone login update error:", moveError.message);
        else account.email = phoneLogin;
      }
    }

    const deliverTo = String(account.profile.email || "").trim() || String(profiles.find((p) => p.email)?.email || "").trim();
    if (!deliverTo) return { reason: "no_email" };

    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: "recovery",
      email: account.email,
      options: { redirectTo },
    });
    if (linkError || !linkData?.properties?.action_link) {
      console.error("generateLink error:", linkError?.message);
      return { reason: "link_failed", detail: linkError?.message };
    }

    const html = renderResetEmail({
      firstName: account.profile.first_name || "",
      actionLink: linkData.properties.action_link,
      contactEmail,
    });
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromEmail, to: [deliverTo], subject: "Restablecer tu contraseña | Reset your password", html }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Resend error:", detail);
      return { reason: "email_failed", detail };
    }
    return { sent_to: deliverTo, staff };
  };

  try {
    const body = await req.json();
    const redirectTo = String(body?.redirect_to || "https://piel-spa.com/reset-password.html");

    // An admin sending the link from the patient's menu sees exactly what happened.
    if (body?.patient_id) {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: authData } = await adminClient.auth.getUser(token);
      if (!authData?.user) return jsonResponse({ error: "not_signed_in" }, 401);
      const { data: role } = await adminClient.from("staff_roles").select("role").eq("user_id", authData.user.id).maybeSingle();
      if (role?.role !== "admin") return jsonResponse({ error: "not_allowed" }, 403);
      const { data: profile } = await adminClient.from("profiles").select("id, email, first_name, phone").eq("id", String(body.patient_id)).maybeSingle();
      if (!profile) return jsonResponse({ error: "not_found" }, 404);
      const outcome = await sendResetLink([profile], redirectTo, true);
      return jsonResponse(outcome.sent_to ? { ok: true, ...outcome } : { error: outcome.reason, detail: outcome.detail }, outcome.sent_to ? 200 : 502);
    }

    // Public form: always { ok: true }, found or not, so it can't be used to
    // find out which phone numbers are registered.
    const phoneDigits = onlyDigits(body?.phone);
    if (!phoneDigits) return jsonResponse({ error: "Missing phone" }, 400);
    if (phoneDigits.length < 7) return jsonResponse({ ok: true });

    // profiles.phone may or may not carry the country code; so may what was typed.
    const { data: profiles } = await adminClient
      .from("profiles")
      .select("id, email, first_name, phone")
      .ilike("phone", `%${phoneDigits.slice(-10)}`)
      .limit(5);
    if (profiles?.length) {
      const outcome = await sendResetLink(profiles, redirectTo);
      if (!outcome.sent_to) console.error("password reset not sent:", outcome.reason);
    }
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: true });
  }
});
