-- 1. admin_delete_patient(): the admin's "Eliminar" on a patient removes
--    everything of theirs in one step (all or nothing): sent messages,
--    encounters, appointments, intake, profile, and the portal login
--    (auth.users) — so the phone/email can be registered again.
--    Photos in storage are removed by the admin page just before this runs.
-- 2. email_is_registered(): lets the intake warn that an email is already in
--    use, like the phone check. Returns only yes/no, never patient data.

create or replace function public.admin_delete_patient(p_patient_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    if exists (select 1 from public.staff_roles where user_id = p_patient_id) then
        raise exception 'staff accounts cannot be deleted here' using errcode = '42501';
    end if;
    delete from public.patient_messages where patient_id::text = p_patient_id::text;
    delete from public.clinical_history where patient_id::text = p_patient_id::text;
    delete from public.appointments where patient_id::text = p_patient_id::text;
    delete from public.admission_history where patient_id::text = p_patient_id::text;
    delete from public.profiles where id::text = p_patient_id::text;
    delete from auth.users where id = p_patient_id;
end;
$$;

revoke all on function public.admin_delete_patient(uuid) from public, anon;
grant execute on function public.admin_delete_patient(uuid) to authenticated;

-- p_exclude_id: when editing a patient, their own current email doesn't count.
create or replace function public.email_is_registered(p_email text, p_exclude_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where lower(btrim(email)) = lower(btrim(p_email))
          and btrim(coalesce(p_email, '')) <> ''
          and (p_exclude_id is null or id <> p_exclude_id)
    );
$$;

revoke all on function public.email_is_registered(text, uuid) from public;
grant execute on function public.email_is_registered(text, uuid) to anon, authenticated;

-- Read-only check: leftovers from patients deleted BEFORE this fix (their
-- intake and portal login stayed behind). Nothing is deleted here.
select 'intake sin paciente' as tipo, count(*) as cantidad
from public.admission_history a
where not exists (select 1 from public.profiles p where p.id::text = a.patient_id::text)
union all
select 'cuenta de portal sin paciente', count(*)
from auth.users u
where u.email like '%@patients.piel-spa.internal'
  and not exists (select 1 from public.profiles p where p.id = u.id);
