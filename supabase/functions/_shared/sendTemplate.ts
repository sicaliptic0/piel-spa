import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsAppMessage, toWhatsAppId } from "./whatsapp.ts";
import { TEMPLATES, TEMPLATE_LANGUAGE } from "./templates.ts";

// Sends an approved template to a patient and saves it in their chat (created
// if new), linked to the appointment it's about — so the webhook knows which
// appointment a button reply ("Confirmo asistencia") belongs to.
// Used by whatsapp-template (admin), send-appointment-reminders and book-appointment.

export type SendTemplateInput = {
  template: string;
  params: string[];
  patientId?: string | null;
  phone?: string | null;           // used when given, else the patient's profile phone
  appointmentId?: string | null;
  staffUserId?: string | null;     // null = sent by the system
};

export type SendTemplateResult =
  | { ok: true; conversationId: string; messageId?: string; waMessageId: string }
  | { ok: false; error: string; detail?: string; expected?: string[] };

export function renderTemplate(name: string, params: string[]): string {
  const t = TEMPLATES.find((x) => x.name === name);
  if (!t) return "";
  const body = t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? "");
  return [t.header, body].filter(Boolean).join("\n\n");
}

export async function sendTemplate(db: SupabaseClient, input: SendTemplateInput): Promise<SendTemplateResult> {
  const template = TEMPLATES.find((t) => t.name === input.template);
  if (!template) return { ok: false, error: "unknown_template" };
  const params = (input.params || []).map((p) => String(p ?? "").trim());
  if (params.length !== template.params.length || params.some((p) => !p)) {
    return { ok: false, error: "invalid_params", expected: template.params };
  }

  const patientId = input.patientId || null;
  let phone = toWhatsAppId(input.phone);
  let profileName = "";
  if (patientId) {
    const { data: profile } = await db.from("profiles").select("first_name, last_name, phone").eq("id", patientId).maybeSingle();
    if (!phone) phone = toWhatsAppId(profile?.phone);
    profileName = `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim();
  }
  if (!phone) return { ok: false, error: "no_phone" };

  let { data: conv } = await db.from("wa_conversations").select("id, patient_id").eq("phone", phone).maybeSingle();
  if (!conv) {
    const { data: created, error } = await db.from("wa_conversations")
      .insert({ phone, patient_id: patientId, profile_name: profileName || null, bot_active: false })
      .select("id, patient_id").single();
    if (error) return { ok: false, error: error.message };
    conv = created;
  } else if (!conv.patient_id && patientId) {
    await db.from("wa_conversations").update({ patient_id: patientId }).eq("id", conv.id);
  }

  let waMessageId = "";
  let sendError = "";
  try {
    waMessageId = await sendWhatsAppMessage(phone, {
      type: "template",
      template: {
        name: template.name,
        language: { code: TEMPLATE_LANGUAGE },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
      },
    });
  } catch (e) {
    sendError = (e as Error).message;
  }

  const row: Record<string, unknown> = {
    conversation_id: conv!.id,
    direction: "out",
    sender: input.staffUserId ? "staff" : "system",
    staff_user_id: input.staffUserId || null,
    body: renderTemplate(template.name, params),
    wa_message_id: waMessageId || null,
    status: sendError ? "failed" : "sent",
    error: sendError || null,
    template: template.name,
    appointment_id: input.appointmentId || null,
  };
  let { data: saved, error: saveError } = await db.from("wa_messages").insert(row).select("id").single();
  if (saveError && /template|appointment_id/.test(saveError.message)) {
    // Columns not created yet (SQL 20261024_whatsapp_reminders): save without the link.
    delete row.template;
    delete row.appointment_id;
    ({ data: saved } = await db.from("wa_messages").insert(row).select("id").single());
  }

  if (sendError) return { ok: false, error: "send_failed", detail: sendError };
  return { ok: true, conversationId: conv!.id, messageId: saved?.id, waMessageId };
}
