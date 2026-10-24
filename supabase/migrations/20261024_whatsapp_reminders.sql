-- WhatsApp appointment messages linked to their appointment — 2026-10-24.
--
-- Templates sent by the system (reminder the day before, confirmation, change,
-- cancellation) are saved in wa_messages with the template's name and the
-- appointment they're about. When the patient taps a button ("Confirmo
-- asistencia", "Cancelar cita"…), WhatsApp says which message it answers, and
-- the webhook uses this link to update that appointment.

alter table public.wa_messages add column if not exists template text;
alter table public.wa_messages add column if not exists appointment_id text;
create index if not exists wa_messages_appointment_idx on public.wa_messages (appointment_id) where appointment_id is not null;
