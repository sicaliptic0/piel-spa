-- Google Sheets sync (tools/google-sheets-sync.gs, an Apps Script in the
-- clinic's spreadsheet).
--
-- The script can't log in as a staff member, so it gets its own long random
-- key. The key lives in a `private` schema, which the website API doesn't
-- expose, so nobody can read it except here in the SQL editor. The only thing
-- the key unlocks is sheet_export(): the same "Hoy" columns, for a date range
-- of at most ~2 months per call. No clinical notes, photos or intakes.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.sync_tokens (
    name text primary key,
    token text not null,
    created_at timestamptz not null default now()
);

-- 64 random hex characters. Re-running this file keeps the existing key.
insert into private.sync_tokens (name, token)
values ('google_sheets', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create or replace function public.sheet_export(p_token text, p_from date, p_to date)
returns table (
    id text,
    visit_date text,
    visit_time text,
    first_name text,
    last_name text,
    dob text,
    phone text,
    city text,
    state text,
    procedures_summary text,
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
    if p_token is null or not exists (
        select 1 from private.sync_tokens where name = 'google_sheets' and token = p_token
    ) then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
        raise exception 'invalid date range' using errcode = '22023';
    end if;
    return query
    select
        ch.id::text,
        ch.visit_date::text,
        ch.visit_time::text,
        p.first_name::text,
        p.last_name::text,
        p.dob::text,
        p.phone::text,
        ah.city::text,
        ah.state::text,
        ch.procedures_summary,
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
    where ch.visit_date between p_from and p_to
    order by ch.visit_date, ch.visit_time nulls last;
end;
$$;

revoke all on function public.sheet_export(text, date, date) from public;
grant execute on function public.sheet_export(text, date, date) to anon, authenticated;

-- Copy this key into the spreadsheet: menu "Piel Spa" → "Configurar clave de sincronización".
select token as clave_para_google_sheets from private.sync_tokens where name = 'google_sheets';
