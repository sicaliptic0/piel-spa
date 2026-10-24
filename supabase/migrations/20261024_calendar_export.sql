-- Google Calendar sync (tools/google-calendar-sync.gs, an Apps Script in the
-- clinic's Google account) — 2026-10-24.
--
-- Same idea as sheet_export(): the script gets its own random key, kept in the
-- private schema, and the key only unlocks calendar_export(): the upcoming
-- (not cancelled) appointments of every clinic, with the patient's name and
-- phone, for a range of at most ~7 months per call.

insert into private.sync_tokens (name, token)
values ('google_calendar', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create or replace function public.calendar_export(p_token text, p_from date, p_to date)
returns table (
    id text,
    appointment_date text,
    appointment_time text,
    duration_minutes int,
    status text,
    clinic_id text,
    clinic_name text,
    clinic_address text,
    first_name text,
    last_name text,
    phone text,
    service_type text,
    service_type_ids text,
    booked_via text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if p_token is null or not exists (
        select 1 from private.sync_tokens where name = 'google_calendar' and token = p_token
    ) then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 220 then
        raise exception 'invalid date range' using errcode = '22023';
    end if;
    return query
    select
        a.id::text,
        a.appointment_date::text,
        a.appointment_time::text,
        coalesce(a.duration_minutes, 60),
        a.status::text,
        c.id,
        c.name,
        c.address,
        p.first_name::text,
        p.last_name::text,
        p.phone::text,
        a.service_type::text,
        to_jsonb(a.service_type_ids)::text,
        a.booked_via::text
    from public.appointments a
    left join public.profiles p on p.id = a.patient_id
    left join public.clinics c on c.id = coalesce(a.location, 'piel_spa')
    where a.appointment_date between p_from and p_to
      and coalesce(a.status, '') <> 'cancelled'
    order by a.appointment_date, a.appointment_time;
end;
$$;

revoke all on function public.calendar_export(text, date, date) from public;
grant execute on function public.calendar_export(text, date, date) to anon, authenticated;

-- Copy this key into the script (SYNC_KEY at the top of google-calendar-sync.gs).
select token as clave_para_google_calendar from private.sync_tokens where name = 'google_calendar';
