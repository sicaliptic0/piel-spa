-- Encounter redesign (admin "Nuevo encuentro").
-- Adds the new encounter fields. Nothing is dropped: the old SOAP columns
-- (subjective, objective, assessment, plan, suggestions) and the old photo
-- columns (patient_photos, marking_photos, post_photos) stay as they are, so
-- past encounters keep their data and still display in the admin.
-- procedures_realized_ids keeps being filled too (the patient dashboard's
-- "last visit" card reads it).

alter table public.clinical_history
    -- Per-category detail of what was done, e.g.
    -- { "neuromodulators": { "qty": 40, "items": [{ "id": "upper_face_rejuvenation" }], "other": { "label": "Cuello" } },
    --   "biostimulators":  { "items": [{ "id": "sculptra", "qty": 2 }] } }
    add column if not exists procedures_detail jsonb not null default '{}'::jsonb,
    -- Editable one-line summary shown on the encounter card (and later on the "Hoy" tab).
    add column if not exists procedures_summary text,
    -- Amount to charge for this visit, in USD. Set by whoever fills the encounter.
    add column if not exists amount numeric(10, 2),
    -- "Notas y seguimiento": running clinical notes, one date-stamped entry per edit.
    add column if not exists notes text,
    -- Up to 10 photo URLs (clinical-photos bucket), no categories.
    add column if not exists photos jsonb not null default '[]'::jsonb;
