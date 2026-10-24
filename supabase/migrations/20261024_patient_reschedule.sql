-- Patients move their own appointment from WhatsApp — 2026-10-24.
--
-- After "Reprogramar" (or "Necesito cambiarla", "Necesito otro horario",
-- "Sí, reprogramar"), whatsapp-webhook sends menus with the free days and
-- times (clinic_free_slots) and, when the patient picks one, calls this to
-- move the appointment in one locked step. Same clinic and duration; the slot
-- must still be free. A cancelled appointment comes back to life on the new
-- date. The patient chose it, so it counts as confirmed by the patient.
-- Only the webhook (service role) can call it; it has already checked the
-- appointment belongs to the patient writing.

create or replace function public.patient_reschedule_appointment(
    p_appointment_id text,
    p_date date,
    p_time time
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_appt record;
begin
    select id, location, duration_minutes into v_appt
    from public.appointments where id::text = p_appointment_id;
    if v_appt.id is null then
        raise exception 'appointment_not_found' using errcode = 'P0001';
    end if;

    perform pg_advisory_xact_lock(hashtext(case when coalesce(v_appt.location, 'piel_spa') = 'piel_spa'
        then 'public.book_appointment_slot' else 'clinic_booking:' || v_appt.location end));

    if not exists (
        select 1 from public.clinic_free_slots(coalesce(v_appt.location, 'piel_spa'), p_date, p_date,
                                               coalesce(v_appt.duration_minutes, 60), p_appointment_id, interval '2 hours') s
        where s.slot_time = p_time
    ) then
        raise exception 'slot_not_available' using errcode = 'P0001';
    end if;

    -- The reminder fields reset on a date change (appointments_reset_reminder);
    -- the confirmation is set afterwards.
    update public.appointments
       set appointment_date = p_date, appointment_time = p_time, status = 'confirmed', patient_cancelled_at = null
     where id = v_appt.id;
    update public.appointments set patient_confirmed_at = now() where id = v_appt.id;

    return v_appt.id::text;
end;
$$;

revoke all on function public.patient_reschedule_appointment(text, date, time) from public, anon, authenticated;
grant execute on function public.patient_reschedule_appointment(text, date, time) to service_role;
