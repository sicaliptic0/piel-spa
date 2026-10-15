-- Divine Bliss Studio appointments (New Brunswick, NJ) — 2026-10-14.
--
-- Fridays only, 30-minute slots from 9:00 AM to 7:00 PM (last start 6:30 PM).
-- Only an admin can book them, from the patient's history in admin.html.
--
-- 1. appointments.location: null = Piel Spa (every existing row),
--    'divine_bliss' = Divine Bliss Studio.
-- 2. available_slots(): the public agenda ignores Divine Bliss appointments,
--    since they happen in another place and don't take a Piel Spa hour.
-- 3. book_divine_bliss_slot(): checks admin, Friday, :00/:30 from 9:00 to 18:30, not in the
--    past and not taken, then inserts the appointment in one locked step.

-- ---------- 1. Where the appointment happens ----------
alter table public.appointments add column if not exists location text;

-- ---------- 2. Public agenda: same as 20261004, minus Divine Bliss ----------
create or replace function public.available_slots(p_from date default null, p_to date default null)
returns table (slot_date date, slot_time time)
language sql
stable
security definer
set search_path = public
as $$
    with clinic_now as (
        select (now() at time zone 'America/New_York') as ts
    ),
    days as (
        select g::date as day
        from clinic_now,
             generate_series(
                 greatest(coalesce(p_from, clinic_now.ts::date), clinic_now.ts::date),
                 least(coalesce(p_to, clinic_now.ts::date + 60), clinic_now.ts::date + 60),
                 interval '1 day'
             ) g
    )
    select d.day, s.slot_time
    from days d
    join public.booking_slots s on s.weekday = extract(dow from d.day)
    cross join clinic_now
    where (d.day + s.slot_time) > clinic_now.ts + interval '2 hours'
      and not exists (select 1 from public.booking_blocked_dates b where b.day = d.day)
      and not exists (
          select 1 from public.appointments a
          where a.appointment_date = d.day
            and coalesce(a.status, '') <> 'cancelled'
            and coalesce(a.location, '') <> 'divine_bliss'
            and a.appointment_time > s.slot_time - interval '1 hour'
            and a.appointment_time < s.slot_time + interval '1 hour'
      )
    order by 1, 2;
$$;

revoke all on function public.available_slots(date, date) from public;
grant execute on function public.available_slots(date, date) to anon, authenticated, service_role;

-- ---------- 3. Book a Divine Bliss slot (admins only) ----------
create or replace function public.book_divine_bliss_slot(
    p_patient_id uuid,
    p_date date,
    p_time time,
    p_service_type text,
    p_service_ids text[]
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ids_type text;
    v_id text;
begin
    if not public.is_admin() then
        raise exception 'not allowed' using errcode = '42501';
    end if;

    if extract(dow from p_date) <> 5 then
        raise exception 'divine_bliss_fridays_only' using errcode = 'P0001';
    end if;

    if p_time < time '09:00' or p_time > time '18:30' or extract(minute from p_time) not in (0, 30) or extract(second from p_time) <> 0 then
        raise exception 'divine_bliss_invalid_hour' using errcode = 'P0001';
    end if;

    if (p_date + p_time) < (now() at time zone 'America/New_York') then
        raise exception 'divine_bliss_in_past' using errcode = 'P0001';
    end if;

    -- One booking at a time, so the taken-slot check below can't race.
    perform pg_advisory_xact_lock(hashtext('public.book_divine_bliss_slot'));

    if exists (
        select 1 from public.appointments a
        where a.appointment_date = p_date
          and a.location = 'divine_bliss'
          and coalesce(a.status, '') <> 'cancelled'
          and a.appointment_time > p_time - interval '30 minutes'
          and a.appointment_time < p_time + interval '30 minutes'
    ) then
        raise exception 'slot_not_available' using errcode = 'P0001';
    end if;

    -- service_type_ids may be text[] or jsonb (see book_appointment_slot).
    select data_type into v_ids_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments' and column_name = 'service_type_ids';

    if v_ids_type = 'ARRAY' then
        insert into public.appointments (patient_id, service_type, service_type_ids, appointment_date, appointment_time, status, booked_via, location)
        values (p_patient_id, p_service_type, p_service_ids, p_date, p_time, 'confirmed', 'admin', 'divine_bliss')
        returning id::text into v_id;
    else
        insert into public.appointments (patient_id, service_type, service_type_ids, appointment_date, appointment_time, status, booked_via, location)
        values (p_patient_id, p_service_type, to_jsonb(p_service_ids), p_date, p_time, 'confirmed', 'admin', 'divine_bliss')
        returning id::text into v_id;
    end if;

    return v_id;
end;
$$;

revoke all on function public.book_divine_bliss_slot(uuid, date, time, text, text[]) from public, anon;
grant execute on function public.book_divine_bliss_slot(uuid, date, time, text, text[]) to authenticated;
