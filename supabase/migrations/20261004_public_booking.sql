-- Public online booking (agendar.html) — 2026-10-04.
--
-- 1. booking_slots: the clinic's weekly schedule, one row per bookable 1-hour
--    start time. Edit these rows to change the hours (no code change needed).
-- 2. booking_blocked_dates: days the clinic is closed (holidays, vacations).
-- 3. available_slots(): free start times for the next 60 days, in clinic time
--    (New York). Anyone can call it; it returns only dates and times, never
--    who booked what.
-- 4. book_appointment_slot(): checks the slot is still free and inserts the
--    appointment in one locked step, so two people can't take the same hour.
--    Only the book-appointment edge function (service role) can call it; the
--    WhatsApp assistant will reuse it later.
-- 5. appointments.booked_via: where an appointment came from (web / admin /
--    whatsapp), for the admin list.

-- ---------- 1. Weekly schedule ----------
create table if not exists public.booking_slots (
    weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday … 6 = Saturday
    slot_time time not null,
    primary key (weekday, slot_time)
);
alter table public.booking_slots enable row level security;

drop policy if exists "admin_all_booking_slots" on public.booking_slots;
create policy "admin_all_booking_slots" on public.booking_slots
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

insert into public.booking_slots (weekday, slot_time) values
    -- Tuesday
    (2, '10:00'), (2, '11:00'), (2, '12:00'), (2, '13:00'), (2, '15:00'), (2, '16:00'), (2, '17:00'), (2, '18:00'),
    -- Wednesday
    (3, '10:00'), (3, '11:00'), (3, '12:00'), (3, '13:00'), (3, '15:00'), (3, '16:00'), (3, '17:00'), (3, '18:00'),
    -- Thursday
    (4, '16:00'), (4, '17:00'), (4, '18:00'), (4, '19:00'),
    -- Saturday
    (6, '15:30'), (6, '16:30'), (6, '17:30'), (6, '18:30'), (6, '19:30')
on conflict do nothing;

-- ---------- 2. Closed days ----------
create table if not exists public.booking_blocked_dates (
    day date primary key,
    reason text
);
alter table public.booking_blocked_dates enable row level security;

drop policy if exists "admin_all_booking_blocked_dates" on public.booking_blocked_dates;
create policy "admin_all_booking_blocked_dates" on public.booking_blocked_dates
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- ---------- 5. Where the appointment came from ----------
alter table public.appointments add column if not exists booked_via text;

-- ---------- 3. Free slots ----------
-- Appointments last 1 hour, so a slot is taken by any non-cancelled
-- appointment starting less than an hour before or after it (this also
-- covers appointments the admin entered at odd times, like 10:30).
-- Slots starting in less than 2 hours are not offered.
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
            and a.appointment_time > s.slot_time - interval '1 hour'
            and a.appointment_time < s.slot_time + interval '1 hour'
      )
    order by 1, 2;
$$;

revoke all on function public.available_slots(date, date) from public;
grant execute on function public.available_slots(date, date) to anon, authenticated, service_role;

-- ---------- 4. Book a slot (atomic) ----------
create or replace function public.book_appointment_slot(
    p_patient_id uuid,
    p_date date,
    p_time time,
    p_service_type text,
    p_service_ids text[],
    p_status text default 'confirmed',
    p_booked_via text default 'web'
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
    -- One booking at a time, so the free-slot check below can't race.
    perform pg_advisory_xact_lock(hashtext('public.book_appointment_slot'));

    if not exists (select 1 from public.available_slots(p_date, p_date) s where s.slot_time = p_time) then
        raise exception 'slot_not_available' using errcode = 'P0001';
    end if;

    -- service_type_ids may be text[] or jsonb depending on how the table was
    -- first created; insert in whichever shape the column has.
    select data_type into v_ids_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments' and column_name = 'service_type_ids';

    if v_ids_type = 'ARRAY' then
        insert into public.appointments (patient_id, service_type, service_type_ids, appointment_date, appointment_time, status, booked_via)
        values (p_patient_id, p_service_type, p_service_ids, p_date, p_time, p_status, p_booked_via)
        returning id::text into v_id;
    else
        insert into public.appointments (patient_id, service_type, service_type_ids, appointment_date, appointment_time, status, booked_via)
        values (p_patient_id, p_service_type, to_jsonb(p_service_ids), p_date, p_time, p_status, p_booked_via)
        returning id::text into v_id;
    end if;

    return v_id;
end;
$$;

revoke all on function public.book_appointment_slot(uuid, date, time, text, text[], text, text) from public, anon, authenticated;
grant execute on function public.book_appointment_slot(uuid, date, time, text, text[], text, text) to service_role;
