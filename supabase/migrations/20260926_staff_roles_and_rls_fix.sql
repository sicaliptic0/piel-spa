-- Staff roles (admin / front desk) + security fixes found on 2026-09-26.
--
-- 1. SECURITY FIX: admission_history had a policy "Admin full access
--    admission_history" with condition `true` for role `public`, which let
--    ANYONE (even without logging in) read, change or delete every intake.
--    It is replaced by an admin-only policy. Patients keep their existing
--    "own row" policies; the intake's new-account flow writes through the
--    create-patient-account edge function (service role), so it's unaffected.
-- 2. SECURITY FIX: patient_messages let any logged-in user insert a message
--    into any patient's inbox. Only the admin sends messages (it already has
--    its own policy), so that policy is dropped.
-- 3. staff_roles: who is admin and who is front desk, by user id. is_admin()
--    (used by existing policies) now reads it; the three admin accounts are
--    seeded from their emails, matching the list in admin.html.
-- 4. Front desk access: NO direct access to any table. It only gets two
--    functions: read the day sheet ("Hoy") and edit a visit's observations.
--    No clinical notes, photos, intakes or amounts can be changed or read
--    beyond what the day sheet shows.

-- ---------- 3. Staff roles ----------
create table if not exists public.staff_roles (
    user_id uuid primary key references auth.users (id) on delete cascade,
    role text not null check (role in ('admin', 'frontdesk')),
    created_at timestamptz not null default now()
);
alter table public.staff_roles enable row level security;

-- Each staff member can see their own role (the admin page uses it to decide
-- what to show). Nobody can change roles through the API; that's done here in SQL.
drop policy if exists "staff_read_own_role" on public.staff_roles;
create policy "staff_read_own_role" on public.staff_roles
    for select to authenticated
    using (user_id = auth.uid());

insert into public.staff_roles (user_id, role)
select id, 'admin' from auth.users
where lower(email) in ('samuel.galviz@gmail.com', 'freddyjosevp@gmail.com', 'pielspanyc@gmail.com')
on conflict (user_id) do update set role = excluded.role;

insert into public.staff_roles (user_id, role)
select id, 'frontdesk' from auth.users
where lower(email) = 'frontdesk@piel-spa.com'
on conflict (user_id) do update set role = excluded.role;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from public.staff_roles where user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_frontdesk()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from public.staff_roles where user_id = auth.uid() and role = 'frontdesk');
$$;

-- ---------- 1. admission_history ----------
drop policy if exists "Admin full access admission_history" on public.admission_history;
drop policy if exists "admin_all_admission_history" on public.admission_history;
create policy "admin_all_admission_history" on public.admission_history
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- ---------- 2. patient_messages ----------
drop policy if exists "Authenticated users can send patient messages" on public.patient_messages;

-- ---------- 4. Front desk: day sheet + observations ----------
-- Everything the "Hoy" tab shows for one date, one row per visit, ordered by
-- visit time. Admin or front desk only.
create or replace function public.day_sheet(p_date date)
returns table (
    id text,
    patient_id text,
    visit_date text,
    visit_time text,
    first_name text,
    last_name text,
    dob text,
    phone text,
    city text,
    state text,
    procedures_summary text,
    procedures_detail jsonb,
    procedures_realized_ids text,
    amount numeric,
    frontdesk_notes text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not (public.is_admin() or public.is_frontdesk()) then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    return query
    select
        ch.id::text,
        ch.patient_id::text,
        ch.visit_date::text,
        ch.visit_time::text,
        p.first_name::text,
        p.last_name::text,
        p.dob::text,
        p.phone::text,
        ah.city::text,
        ah.state::text,
        ch.procedures_summary,
        ch.procedures_detail,
        to_jsonb(ch.procedures_realized_ids)::text,
        ch.amount,
        ch.frontdesk_notes
    from public.clinical_history ch
    left join public.profiles p on p.id = ch.patient_id
    left join lateral (
        select a.city, a.state from public.admission_history a
        where a.patient_id = ch.patient_id
        limit 1
    ) ah on true
    where ch.visit_date = p_date
    order by ch.visit_time nulls last;
end;
$$;

-- The only thing the front desk can change: a visit's observations.
create or replace function public.set_frontdesk_notes(p_encounter_id text, p_notes text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not (public.is_admin() or public.is_frontdesk()) then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    update public.clinical_history
    set frontdesk_notes = nullif(btrim(p_notes), '')
    where id::text = p_encounter_id;
end;
$$;

revoke all on function public.day_sheet(date) from public, anon;
revoke all on function public.set_frontdesk_notes(text, text) from public, anon;
grant execute on function public.day_sheet(date) to authenticated;
grant execute on function public.set_frontdesk_notes(text, text) to authenticated;

-- Quick check after running: should list the 3 admins and the front desk.
select u.email, r.role from public.staff_roles r join auth.users u on u.id = r.user_id order by r.role, u.email;
