-- Imports the patients seen before the system existed (Divine Bliss Studio,
-- "Lista de pacientes", 2026-08-09 → 2026-09-11).
--
-- * Each patient gets a profile WITHOUT a portal login (is_manual_patient =
--   true): nothing is created in auth.users, so no account exists until the
--   patient authorizes it.
-- * profiles.created_at = the date of their FIRST visit (not today).
-- * Each visit becomes an encounter in clinical_history with its real
--   visit_date (Liset Jimenez and Liliana Silverio get two).
-- * Age is kept as a note, not turned into a made-up date of birth.
-- * Patients whose phone is already in profiles are skipped (no duplicates),
--   so running this twice is harmless.
-- * Milton Harold ("No acudió") gets a profile but no encounter.
-- * Patients without a phone number are NOT imported (Maritza, Marily, Christopher).
--
-- Everything runs inside one DO block: the Supabase SQL editor doesn't keep a
-- transaction open across statements, so temp tables must live in one block.
-- The block is all-or-nothing.

do $$
declare
    fk text;
    col text;
begin
    -- 1. Let profiles exist without a portal login.
    alter table public.profiles alter column id set default gen_random_uuid();

    for fk in
        select conname from pg_constraint
        where conrelid = 'public.profiles'::regclass and contype = 'f'
          and confrelid = 'auth.users'::regclass
    loop
        execute format('alter table public.profiles drop constraint %I', fk);
    end loop;

    -- Imported records may lack these; the web forms still require them.
    foreach col in array array['user_id', 'last_name', 'dob', 'sex', 'email', 'phone'] loop
        if exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'profiles'
              and column_name = col and is_nullable = 'NO'
        ) then
            execute format('alter table public.profiles alter column %I drop not null', col);
        end if;
    end loop;

    -- 2. The list, one row per visit.
    drop table if exists import_visits;
    create temp table import_visits (
        visit_date date, visit_time time, first_name text, last_name text, age int,
        phone text, phone2 text, summary text, city text, attended boolean
    );

    insert into import_visits values
        ('2026-08-09', null,    'Belgica',   'Gonzales',          42, '6097430400', null,         'Botox 50 UI',                   'Trenton, NJ',     true),
        ('2026-08-09', null,    'Elisa',     'Ayala',             45, '8483916781', null,         'Botox 35 / Sculptra 1 vial',    'New Brunswick',   true),
        ('2026-08-09', null,    'Ismari',    'Medina',            37, '7327909442', '9083314327', 'Sculptra 1 vial / Skinbooster', 'New Brunswick',   true),
        ('2026-08-09', null,    'Liset',     'Jimenez',           34, '7326263080', null,         'Botox 35 UI',                   'North Brunswick', true),
        ('2026-08-09', null,    'Omairy',    'Garcia',            32, '7322078745', null,         'NCTF + Botox 30 UI',            'Somerset',        true),
        ('2026-08-09', null,    'Magdalena', 'Osorio Fernandez',  49, '7326904416', null,         'Profile Structure / PRP',       'North Brunswick', true),
        ('2026-08-16', null,    'Liliana',   'Silverio',          52, '7324703166', null,         'Consulta',                      'Princeton',       true),
        ('2026-08-16', null,    'Carolina',  'Aular Rotondi',     64, '3862250765', null,         'Botox 50 + NCTF',               'Edison, NJ',      true),
        ('2026-08-16', null,    'Jessica',   'Cruz',              50, '9392992198', null,         'Botox',                         'New Brunswick',   true),
        ('2026-08-16', null,    'Rossy',     'Villegas',          33, '9082749960', null,         'Fillers 2 viales y Botox',      'New Brunswick',   true),
        ('2026-08-16', null,    'Leo',       'Herrera',           57, '9084214472', null,         'Botox y 2 Sculptra',            'New Brunswick',   true),
        ('2026-08-16', null,    'Liset',     'Jimenez',           34, '7326263080', null,         'Retoque Botox',                 null,              true),
        ('2026-08-30', null,    'Jennifer',  'Jimenez',           31, '7325103116', null,         '6 fillers + Sculptra',          'Perth Amboy',     true),
        ('2026-08-30', null,    'Liliana',   'Silverio',          52, '7324703166', null,         'Botox 55 UI',                   'Princeton',       true),
        ('2026-08-30', null,    'Yanire',    'Nova',              51, '8482005878', null,         'Botox 40 UI + NCTF',            'New Brunswick',   true),
        ('2026-08-30', null,    'Mercedes',  'LeBron',            64, '7326210755', null,         'Consulta mancha piel',          'New Brunswick',   true),
        ('2026-08-30', null,    'María',     'Vera Ruiz',         55, '6098791429', null,         'Consulta flacidez',             null,              true),
        ('2026-08-30', null,    'Yadira',    'Peralta',           null, '7327151617', null,       'Retoque Botox',                 null,              true),
        ('2026-09-11', null,    'Milton',    'Harold',            null, '9084491137', null,       'No acudió',                     null,              false),
        ('2026-09-11', '16:13', 'Andrea',    'Santana',           40, '9084490761', null,         'Botox',                         null,              true),
        ('2026-09-11', null,    'Sandra',    'Acevedo',           70, '8572639839', null,         'Juvelook · Seguimiento',        null,              true),
        ('2026-09-11', null,    'Mariel',    'Marte',             36, '2014814053', null,         'Consulta',                      'Plainfield',      true);

    -- 3. One patient per phone. Rows without a phone are never imported.
    drop table if exists import_patients;
    create temp table import_patients as
    select
        gen_random_uuid() as id,
        phone,
        (array_agg(first_name order by visit_date))[1] as first_name,
        (array_agg(last_name order by visit_date))[1] as last_name,
        min(visit_date) as first_visit,
        false as already_exists
    from import_visits
    where coalesce(btrim(phone), '') <> ''
    group by phone;

    -- Skip anyone already in the system (same last 10 phone digits).
    update import_patients ip set already_exists = true
    where exists (
        select 1 from public.profiles p
        where right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = ip.phone
    );

    -- 4. Profiles, dated on their first visit (noon New York time).
    insert into public.profiles (id, first_name, last_name, phone, clinic_affiliation, is_manual_patient, created_at)
    select id, first_name, last_name, '+1' || phone, array['divine'], true,
           (first_visit + time '12:00') at time zone 'America/New_York'
    from import_patients
    where not already_exists;

    -- 5. Encounters with their real visit dates.
    insert into public.clinical_history (patient_id, visit_date, visit_time, procedures_summary, notes)
    select ip.id, v.visit_date, v.visit_time, v.summary,
           concat_ws(' · ',
               'Atención previa al sistema (importada de la lista de pacientes de Divine Bliss Studio)',
               'Edad reportada: ' || v.age,
               'Ciudad: ' || v.city,
               'Otro teléfono: +1' || v.phone2)
    from import_visits v
    join import_patients ip on ip.phone = v.phone
    where not ip.already_exists and v.attended;

    drop table import_visits;
    drop table import_patients;
end $$;

-- 6. Check: the imported patients and their visits.
select
    p.first_name || coalesce(' ' || p.last_name, '') as paciente,
    p.phone as telefono,
    to_char(p.created_at at time zone 'America/New_York', 'MM/DD/YYYY') as registrado_desde,
    count(c.id) as atenciones
from public.profiles p
left join public.clinical_history c on c.patient_id::text = p.id::text
where p.is_manual_patient
  and 'divine' = any(p.clinic_affiliation)
  and p.created_at >= '2026-08-09' and p.created_at < '2026-09-12'
group by p.id
order by p.created_at, p.first_name;
