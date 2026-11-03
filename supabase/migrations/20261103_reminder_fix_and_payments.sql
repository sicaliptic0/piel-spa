-- Reminder job fix, confirmation channel and "Cobros" — 2026-11-03.
--
-- 1. The hourly reminder job was saved with its key masked ("eyJhbGci••••"), so
--    send-appointment-reminders answered 401 and no reminder ever went out.
--    Re-created here with the real (public) anon key.
-- 2. appointments.patient_confirmed_via: where the patient confirmed
--    ('whatsapp' | 'email'), so the other channel can say it's already done.
-- 3. payments: what each patient paid (admin "Cobros"). Patient name and visit
--    date are copied in, so the record survives deleting the patient/encounter.

-- ---------- 1. Hourly job ----------
select cron.unschedule('appointment-reminders')
where exists (select 1 from cron.job where jobname = 'appointment-reminders');

select cron.schedule(
    'appointment-reminders',
    '5 * * * *',
    $job$
    select net.http_post(
        url := 'https://qkjmrnqkoipdltauweub.supabase.co/functions/v1/send-appointment-reminders',
        headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFram1ybnFrb2lwZGx0YXV3ZXViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTkyMjgsImV4cCI6MjA4OTA5NTIyOH0.EGqgJ9RNY9vYfuVeeEcGoMu_cIaygRq0hnyT-iE7zTw"}'::jsonb,
        body := '{}'::jsonb
    );
    $job$
);

-- ---------- 2. Confirmation channel ----------
alter table public.appointments add column if not exists patient_confirmed_via text;

create or replace function public.appointments_reset_reminder()
returns trigger
language plpgsql
as $$
begin
    if new.appointment_date is distinct from old.appointment_date
       or new.appointment_time is distinct from old.appointment_time then
        new.reminder_sent_at := null;
        new.reminder_channel := null;
        new.patient_confirmed_at := null;
        new.patient_confirmed_via := null;
    end if;
    return new;
end;
$$;

-- ---------- 3. Payments ----------
create table if not exists public.payments (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid references public.profiles (id) on delete set null,
    patient_name text not null,
    encounter_id uuid references public.clinical_history (id) on delete set null,
    visit_date date,
    paid_on date not null,
    method text not null check (method in ('cash', 'transfer', 'debit', 'credit', 'check', 'other')),
    amount numeric(10, 2) not null check (amount >= 0),   -- before discount and tax
    discount numeric(10, 2) not null default 0 check (discount >= 0),
    friend_coupon boolean not null default false,         -- the discount is a "cupo de amigos"
    tax_rate numeric(5, 2) not null default 0,            -- percent, e.g. 4.50
    tax numeric(10, 2) not null default 0,
    total numeric(10, 2) not null,
    notes text,
    created_by uuid,
    created_at timestamptz not null default now(),
    voided_at timestamptz,                                -- "Anular": kept, but no longer counted
    voided_by uuid
);
create index if not exists payments_paid_on_idx on public.payments (paid_on desc);
create index if not exists payments_patient_idx on public.payments (patient_id);
create index if not exists payments_encounter_idx on public.payments (encounter_id);
alter table public.payments enable row level security;

drop policy if exists "admin_all_payments" on public.payments;
create policy "admin_all_payments" on public.payments
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
