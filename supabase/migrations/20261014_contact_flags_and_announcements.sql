-- "No contactar" + announcements — 2026-10-14.
--
-- 1. patient_staff_flags: the clinic's own decision not to write to a patient
--    (e.g. a difficult relationship), with a private note. It lives apart from
--    profiles because patients can read their own profile row; this table is
--    admins only. It excludes the patient from announcements and asks before
--    writing to them; appointment reminders/confirmations still go if they book.
-- 2. announcements / announcement_recipients: a message written once in
--    Pacientes → "📣 Anuncio" and sent to many patients, by WhatsApp (assisted,
--    one by one) and/or email; recipients are logged so nobody gets it twice.

-- ---------- 1. No contactar ----------
create table if not exists public.patient_staff_flags (
    patient_id uuid primary key,
    do_not_contact boolean not null default false,
    note text,
    updated_at timestamptz not null default now(),
    updated_by uuid default auth.uid()
);
alter table public.patient_staff_flags enable row level security;
drop policy if exists "admin_all_patient_staff_flags" on public.patient_staff_flags;
create policy "admin_all_patient_staff_flags" on public.patient_staff_flags
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- 2. Announcements ----------
create table if not exists public.announcements (
    id uuid primary key default gen_random_uuid(),
    body text not null,
    created_by uuid default auth.uid(),
    created_at timestamptz not null default now()
);
create table if not exists public.announcement_recipients (
    announcement_id uuid not null references public.announcements (id) on delete cascade,
    patient_id uuid not null,
    channel text not null check (channel in ('whatsapp', 'email')),
    sent_at timestamptz not null default now(),
    primary key (announcement_id, patient_id, channel)
);
alter table public.announcements enable row level security;
alter table public.announcement_recipients enable row level security;
drop policy if exists "admin_all_announcements" on public.announcements;
create policy "admin_all_announcements" on public.announcements
    for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin_all_announcement_recipients" on public.announcement_recipients;
create policy "admin_all_announcement_recipients" on public.announcement_recipients
    for all to authenticated using (public.is_admin()) with check (public.is_admin());
