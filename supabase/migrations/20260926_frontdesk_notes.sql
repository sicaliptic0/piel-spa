-- "Hoy" tab (admin daily sheet).
-- Front-desk observations for a visit (billing notes, reminders), kept apart
-- from the clinical "Notas y seguimiento" (clinical_history.notes). Later the
-- front-desk user will be able to edit only this column.

alter table public.clinical_history
    add column if not exists frontdesk_notes text;
