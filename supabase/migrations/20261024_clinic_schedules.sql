-- Clinic schedules editable from admin.html ("Horarios") and one booking path
-- for every clinic — 2026-10-24.
--
-- 1. clinics: Piel Spa (Manhattan) and Divine Bliss Studio (North Brunswick, NJ),
--    with address and the step between offered start times.
-- 2. clinic_hours: weekly opening ranges per clinic (e.g. Tue 10:00–14:00 and
--    15:00–19:00). Piel Spa's are copied from booking_slots; Divine Bliss gets
--    Fridays 9:00–19:00 (what book_divine_bliss_slot allowed).
-- 3. clinic_exceptions: per-date changes —
--      closed, no hours  → the whole day is closed
--      closed, hours     → those hours are blocked
--      open,   hours     → extra hours that day (also on a normally closed day)
--    Piel Spa's booking_blocked_dates are copied in as closed days.
-- 4. appointments.duration_minutes (1 h default, 30 min for touch-ups) and
--    appointments.location defaults to 'piel_spa' (old rows filled in).
-- 5. clinic_free_slots(): free start times for a clinic and a duration, from
--    hours + exceptions − appointments (overlaps use each one's duration).
--    available_slots() (public agenda, agendar.html) now reads it for Piel Spa.
-- 6. admin_book_appointment(): admins create or reschedule an appointment in
--    any clinic, in one locked step; p_force books outside the schedule.

-- ---------- 1. Clinics ----------
create table if not exists public.clinics (
    id text primary key,
    name text not null,
    address text,
    slot_step_minutes int not null default 60 check (slot_step_minutes in (15, 30, 60)),
    sort smallint not null default 0
);
alter table public.clinics enable row level security;

drop policy if exists "read_clinics" on public.clinics;
create policy "read_clinics" on public.clinics for select to anon, authenticated using (true);
drop policy if exists "admin_write_clinics" on public.clinics;
create policy "admin_write_clinics" on public.clinics
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

insert into public.clinics (id, name, address, slot_step_minutes, sort) values
    ('piel_spa', 'Piel Spa', '481 8th Ave, Suite 1221, New York, NY 10001', 60, 1),
    ('divine_bliss', 'Divine Bliss Studio', '529 Milltown Rd, North Brunswick Township, NJ 08902', 30, 2)
on conflict (id) do nothing;

-- ---------- 2. Weekly hours ----------
create table if not exists public.clinic_hours (
    id bigint generated always as identity primary key,
    clinic_id text not null references public.clinics (id) on delete cascade,
    weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday … 6 = Saturday
    start_time time not null,
    end_time time not null,
    check (end_time > start_time)
);
create index if not exists clinic_hours_clinic_idx on public.clinic_hours (clinic_id, weekday);
alter table public.clinic_hours enable row level security;

drop policy if exists "admin_all_clinic_hours" on public.clinic_hours;
create policy "admin_all_clinic_hours" on public.clinic_hours
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- Piel Spa: consecutive 1-hour slots of booking_slots become one range.
insert into public.clinic_hours (clinic_id, weekday, start_time, end_time)
select 'piel_spa', weekday, min(slot_time), (max(slot_time) + interval '1 hour')::time
from (
    select weekday, slot_time,
           slot_time - (row_number() over (partition by weekday order by slot_time)) * interval '1 hour' as grp
    from public.booking_slots
) s
where not exists (select 1 from public.clinic_hours where clinic_id = 'piel_spa')
group by weekday, grp;

insert into public.clinic_hours (clinic_id, weekday, start_time, end_time)
select 'divine_bliss', 5, '09:00', '19:00'
where not exists (select 1 from public.clinic_hours where clinic_id = 'divine_bliss');

-- ---------- 3. Exceptions ----------
create table if not exists public.clinic_exceptions (
    id bigint generated always as identity primary key,
    clinic_id text not null references public.clinics (id) on delete cascade,
    day date not null,
    kind text not null check (kind in ('closed', 'open')),
    start_time time,
    end_time time,
    note text,
    created_at timestamptz not null default now(),
    check ((start_time is null and end_time is null and kind = 'closed') or (start_time is not null and end_time > start_time))
);
create index if not exists clinic_exceptions_day_idx on public.clinic_exceptions (clinic_id, day);
alter table public.clinic_exceptions enable row level security;

drop policy if exists "admin_all_clinic_exceptions" on public.clinic_exceptions;
create policy "admin_all_clinic_exceptions" on public.clinic_exceptions
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

insert into public.clinic_exceptions (clinic_id, day, kind, note)
select 'piel_spa', b.day, 'closed', b.reason
from public.booking_blocked_dates b
where not exists (select 1 from public.clinic_exceptions e where e.clinic_id = 'piel_spa' and e.day = b.day and e.kind = 'closed' and e.start_time is null);

-- ---------- 4. Appointment duration and clinic ----------
alter table public.appointments add column if not exists duration_minutes int not null default 60;
alter table public.appointments alter column location set default 'piel_spa';
update public.appointments set location = 'piel_spa' where location is null;

-- ---------- 5. Free start times ----------
create or replace function public.clinic_free_slots(
    p_clinic text,
    p_from date default null,
    p_to date default null,
    p_duration int default 60,
    p_exclude_appointment text default null,
    p_lead interval default interval '0'
)
returns table (slot_date date, slot_time time)
language sql
stable
security definer
set search_path = public
as $$
    with clinic as (
        select id, slot_step_minutes from public.clinics where id = p_clinic
    ),
    clinic_now as (
        select (now() at time zone 'America/New_York') as ts
    ),
    days as (
        select g::date as day
        from clinic_now,
             generate_series(
                 greatest(coalesce(p_from, clinic_now.ts::date), clinic_now.ts::date),
                 least(coalesce(p_to, clinic_now.ts::date + 60), clinic_now.ts::date + 180),
                 interval '1 day'
             ) g
    ),
    ranges as (
        select d.day, h.start_time, h.end_time
        from days d
        join public.clinic_hours h on h.clinic_id = p_clinic and h.weekday = extract(dow from d.day)
        where not exists (
            select 1 from public.clinic_exceptions e
            where e.clinic_id = p_clinic and e.day = d.day and e.kind = 'closed' and e.start_time is null
        )
        union
        select e.day, e.start_time, e.end_time
        from public.clinic_exceptions e
        join days d on d.day = e.day
        where e.clinic_id = p_clinic and e.kind = 'open'
    ),
    starts as (
        select distinct r.day, g as ts
        from ranges r
        cross join clinic c
        cross join lateral generate_series(
            r.day + r.start_time,
            r.day + r.end_time - make_interval(mins => p_duration),
            make_interval(mins => c.slot_step_minutes)
        ) g
    )
    select s.day, s.ts::time
    from starts s
    cross join clinic_now n
    where s.ts >= n.ts + p_lead
      and not exists (
          select 1 from public.clinic_exceptions e
          where e.clinic_id = p_clinic and e.day = s.day and e.kind = 'closed' and e.start_time is not null
            and (e.day + e.start_time) < s.ts + make_interval(mins => p_duration)
            and (e.day + e.end_time) > s.ts
      )
      and not exists (
          select 1 from public.appointments a
          where coalesce(a.location, 'piel_spa') = p_clinic
            and a.appointment_date = s.day
            and coalesce(a.status, '') <> 'cancelled'
            and (p_exclude_appointment is null or a.id::text <> p_exclude_appointment)
            and (a.appointment_date + a.appointment_time) < s.ts + make_interval(mins => p_duration)
            and (a.appointment_date + a.appointment_time + make_interval(mins => coalesce(a.duration_minutes, 60))) > s.ts
      )
    order by 1, 2;
$$;

revoke all on function public.clinic_free_slots(text, date, date, int, text, interval) from public;
grant execute on function public.clinic_free_slots(text, date, date, int, text, interval) to anon, authenticated, service_role;

-- Public agenda: Piel Spa, 1-hour appointments, next 60 days, not within 2 hours.
create or replace function public.available_slots(p_from date default null, p_to date default null)
returns table (slot_date date, slot_time time)
language sql
stable
security definer
set search_path = public
as $$
    select f.slot_date, f.slot_time
    from public.clinic_free_slots(
        'piel_spa',
        p_from,
        least(coalesce(p_to, (now() at time zone 'America/New_York')::date + 60), (now() at time zone 'America/New_York')::date + 60),
        60,
        null,
        interval '2 hours'
    ) f;
$$;

revoke all on function public.available_slots(date, date) from public;
grant execute on function public.available_slots(date, date) to anon, authenticated, service_role;

-- ---------- 6. Admin booking / rescheduling ----------
create or replace function public.admin_book_appointment(
    p_patient_id uuid,
    p_clinic text,
    p_date date,
    p_time time,
    p_duration int,
    p_service_type text,
    p_service_ids text[],
    p_force boolean default false,
    p_appointment_id text default null
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
    if not exists (select 1 from public.clinics where id = p_clinic) then
        raise exception 'unknown_clinic' using errcode = 'P0001';
    end if;
    if p_duration is null or p_duration < 15 or p_duration > 480 then
        raise exception 'invalid_duration' using errcode = 'P0001';
    end if;

    -- Same lock as the public booking for Piel Spa, so both can't take one hour.
    perform pg_advisory_xact_lock(hashtext(case when p_clinic = 'piel_spa' then 'public.book_appointment_slot' else 'clinic_booking:' || p_clinic end));

    if not p_force and not exists (
        select 1 from public.clinic_free_slots(p_clinic, p_date, p_date, p_duration, p_appointment_id) s
        where s.slot_time = p_time
    ) then
        raise exception 'slot_not_available' using errcode = 'P0001';
    end if;

    select data_type into v_ids_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments' and column_name = 'service_type_ids';

    if p_appointment_id is not null then
        if v_ids_type = 'ARRAY' then
            update public.appointments
               set location = p_clinic, appointment_date = p_date, appointment_time = p_time, duration_minutes = p_duration,
                   service_type = p_service_type, service_type_ids = p_service_ids, status = 'modified'
             where id::text = p_appointment_id
            returning id::text into v_id;
        else
            update public.appointments
               set location = p_clinic, appointment_date = p_date, appointment_time = p_time, duration_minutes = p_duration,
                   service_type = p_service_type, service_type_ids = to_jsonb(p_service_ids), status = 'modified'
             where id::text = p_appointment_id
            returning id::text into v_id;
        end if;
        if v_id is null then
            raise exception 'appointment_not_found' using errcode = 'P0001';
        end if;
        return v_id;
    end if;

    if v_ids_type = 'ARRAY' then
        insert into public.appointments (patient_id, service_type, service_type_ids, appointment_date, appointment_time, duration_minutes, status, booked_via, location)
        values (p_patient_id, p_service_type, p_service_ids, p_date, p_time, p_duration, 'confirmed', 'admin', p_clinic)
        returning id::text into v_id;
    else
        insert into public.appointments (patient_id, service_type, service_type_ids, appointment_date, appointment_time, duration_minutes, status, booked_via, location)
        values (p_patient_id, p_service_type, to_jsonb(p_service_ids), p_date, p_time, p_duration, 'confirmed', 'admin', p_clinic)
        returning id::text into v_id;
    end if;

    return v_id;
end;
$$;

revoke all on function public.admin_book_appointment(uuid, text, date, time, int, text, text[], boolean, text) from public, anon;
grant execute on function public.admin_book_appointment(uuid, text, date, time, int, text, text[], boolean, text) to authenticated;
