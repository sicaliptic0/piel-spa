-- Consent to receive promotions by WhatsApp — 2026-10-13.
--
-- marketing_consent: null = never asked · 'yes' · 'no'
-- marketing_consent_source: where it was given or changed —
--   web (agendar.html) · intake (intake.html) · whatsapp (button or BAJA/STOP
--   reply) · staff (changed by hand in the admin)
-- marketing_invite_sent_at: when the WhatsApp invitation template was sent, so
--   nobody gets it twice.
-- Only patients with marketing_consent = 'yes' may receive promotions.

alter table public.profiles
    add column if not exists marketing_consent text check (marketing_consent in ('yes', 'no')),
    add column if not exists marketing_consent_at timestamptz,
    add column if not exists marketing_consent_source text,
    add column if not exists marketing_invite_sent_at timestamptz;

select
    coalesce(marketing_consent, 'sin preguntar') as consentimiento,
    count(*) as pacientes
from public.profiles
where not exists (select 1 from public.staff_roles s where s.user_id = profiles.id)
group by 1
order by 1;
