-- When the admin sent tomorrow's reminder by WhatsApp from the "Recordatorios
-- de mañana" panel (admin.html → Citas). Reset with the other reminder fields
-- when the appointment's date or time changes.

alter table public.appointments add column if not exists whatsapp_reminder_at timestamptz;

create or replace function public.appointments_reset_reminder()
returns trigger
language plpgsql
as $$
begin
    if new.appointment_date is distinct from old.appointment_date
       or new.appointment_time is distinct from old.appointment_time then
        new.reminder_sent_at := null;
        new.reminder_channel := null;
        new.whatsapp_reminder_at := null;
        new.patient_confirmed_at := null;
    end if;
    return new;
end;
$$;
