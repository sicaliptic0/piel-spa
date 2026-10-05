-- Appointment reminders, 1 day before — 2026-10-05.
--
-- 1. New appointment columns:
--    reminder_sent_at / reminder_channel: when and how the reminder went out
--      ('email', later 'whatsapp'; 'none' = no email on file; 'skipped_recent' =
--      booked less than 12 h before, they just got the confirmation).
--    response_token: secret id in the reminder's link (cita.html), so the
--      patient can confirm or cancel without signing in.
--    patient_confirmed_at / patient_cancelled_at: the patient's answer.
-- 2. If the date or time changes, the reminder and the answer reset, so the
--    patient is reminded of the new time.
-- 3. Every hour, pg_cron calls the send-appointment-reminders edge function.
--    It only sends between 10:00 and 20:59 New York time, for tomorrow's
--    appointments not reminded yet, so calling it more often is harmless.

-- ---------- 1. Columns ----------
alter table public.appointments add column if not exists reminder_sent_at timestamptz;
alter table public.appointments add column if not exists reminder_channel text;
alter table public.appointments add column if not exists response_token uuid default gen_random_uuid();
alter table public.appointments add column if not exists patient_confirmed_at timestamptz;
alter table public.appointments add column if not exists patient_cancelled_at timestamptz;
update public.appointments set response_token = gen_random_uuid() where response_token is null;
create unique index if not exists appointments_response_token_idx on public.appointments (response_token);

-- ---------- 2. Reset on reschedule ----------
create or replace function public.appointments_reset_reminder()
returns trigger
language plpgsql
as $$
begin
    if new.appointment_date is distinct from old.appointment_date
       or new.appointment_time is distinct from old.appointment_time then
        new.reminder_sent_at := null;
        new.reminder_channel := null;
        new.patient_confirmed_at := null;
    end if;
    return new;
end;
$$;

drop trigger if exists appointments_reset_reminder on public.appointments;
create trigger appointments_reset_reminder
    before update on public.appointments
    for each row execute function public.appointments_reset_reminder();

-- ---------- 3. Hourly job ----------
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('appointment-reminders')
where exists (select 1 from cron.job where jobname = 'appointment-reminders');

select cron.schedule(
    'appointment-reminders',
    '5 * * * *',
    $job$
    select net.http_post(
        url := 'https://qkjmrnqkoipdltauweub.supabase.co/functions/v1/send-appointment-reminders',
        headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFram1ybnFrb2lwZGx0YXV3ZXViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTkyMjgsImV4cCI6MjA4OTA5NTIyOH0.EGqgJ9RNY9vYfuVeeEcGoMu_cIaygRq0hnyT-iE7zTw"}'::jsonb,
        body := '{}'::jsonb
    );
    $job$
);
