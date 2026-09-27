-- Follow-up reminders ("Recordarme contactar a este paciente").
--
-- The admin sets a date and a reason on an encounter. The Google Sheets
-- Apps Script (tools/google-sheets-sync.gs) runs every morning, asks
-- follow_up_reminders() for the ones due within 3 days that haven't been
-- emailed yet, emails them to the clinic, and marks them as sent.
-- Both functions use the same private key as the Sheets sync.

create table if not exists public.follow_ups (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null,
    encounter_id text unique,          -- one reminder per encounter
    contact_date date not null,
    reason text,
    reminder_sent_at timestamptz,      -- null until the email goes out; reset when the date changes
    created_at timestamptz not null default now()
);
create index if not exists follow_ups_patient_idx on public.follow_ups (patient_id);
alter table public.follow_ups enable row level security;

drop policy if exists "admin_all_follow_ups" on public.follow_ups;
create policy "admin_all_follow_ups" on public.follow_ups
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- Reminders to email now: due in `p_days_ahead` days or sooner (New York
-- date) and not emailed yet. Past dates that were never emailed are included.
create or replace function public.follow_up_reminders(p_token text, p_days_ahead int default 3)
returns table (
    id text,
    contact_date text,
    reason text,
    first_name text,
    last_name text,
    phone text,
    email text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if p_token is null or not exists (
        select 1 from private.sync_tokens where name = 'google_sheets' and token = p_token
    ) then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    return query
    select f.id::text, f.contact_date::text, f.reason,
           p.first_name::text, p.last_name::text, p.phone::text, p.email::text
    from public.follow_ups f
    left join public.profiles p on p.id::text = f.patient_id::text
    where f.reminder_sent_at is null
      and f.contact_date <= (now() at time zone 'America/New_York')::date + greatest(p_days_ahead, 0)
    order by f.contact_date;
end;
$$;

create or replace function public.mark_follow_up_reminders_sent(p_token text, p_ids text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_token is null or not exists (
        select 1 from private.sync_tokens where name = 'google_sheets' and token = p_token
    ) then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    update public.follow_ups set reminder_sent_at = now() where id::text = any(p_ids);
end;
$$;

revoke all on function public.follow_up_reminders(text, int) from public;
revoke all on function public.mark_follow_up_reminders_sent(text, text[]) from public;
grant execute on function public.follow_up_reminders(text, int) to anon, authenticated;
grant execute on function public.mark_follow_up_reminders_sent(text, text[]) to anon, authenticated;

-- Deleting a patient also removes their reminders (same function as before + follow_ups).
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
    delete from public.follow_ups where patient_id = p_patient_id;
    delete from public.patient_messages where patient_id::text = p_patient_id::text;
    delete from public.clinical_history where patient_id::text = p_patient_id::text;
    delete from public.appointments where patient_id::text = p_patient_id::text;
    delete from public.admission_history where patient_id::text = p_patient_id::text;
    delete from public.profiles where id::text = p_patient_id::text;
    delete from auth.users where id = p_patient_id;
end;
$$;
