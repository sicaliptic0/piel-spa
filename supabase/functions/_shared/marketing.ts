// Consent to receive promotions by WhatsApp (profiles.marketing_consent):
// null = never asked · "yes" · "no". Only "yes" may receive promotions.

export type ConsentSource = "web" | "intake" | "whatsapp" | "staff";

// The profile fields to save when a patient answers.
export function consentFields(accepted: boolean, source: ConsentSource) {
  return {
    marketing_consent: accepted ? "yes" : "no",
    marketing_consent_at: new Date().toISOString(),
    marketing_consent_source: source,
  };
}

// The invitation template, created and approved in Meta's WhatsApp Manager:
// Spanish, body with {{1}} = first name, two quick-reply buttons
// "Sí, quiero" / "No, gracias". The name can be overridden with a secret.
export function inviteTemplate() {
  return {
    name: Deno.env.get("WHATSAPP_INVITE_TEMPLATE") ?? "invitacion_promociones",
    language: Deno.env.get("WHATSAPP_INVITE_TEMPLATE_LANG") ?? "es",
  };
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

// What an incoming WhatsApp message says about promotions, if anything.
// Only the invitation's buttons, or an unmistakable opt-out word, count — a
// plain "sí" is left alone (it may be confirming an appointment).
export function consentReply(text: string): "yes" | "no" | null {
  const t = normalize(text);
  if (t === "si quiero") return "yes";
  if (["no gracias", "baja", "stop", "alto", "unsubscribe", "cancelar promociones", "no mas promociones"].includes(t)) return "no";
  return null;
}
