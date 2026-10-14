-- Weight-loss consultation track in the intake.
--
-- weight_loss_history: jsonb array, one row per weight-loss treatment the
--   patient answered "Sí" to (GLP-1, pills, bariatric surgery, ...), same
--   convention as aesthetic_history. Written by intake.html (Module 3).
-- intake_tracks: which history sections the patient has already answered —
--   'aesthetic' and/or 'weight_loss'. The admin uses it to offer "complete the
--   missing part" from an encounter (e.g. a weight-loss patient who now comes
--   for an aesthetic consultation). Null on rows from before this change; the
--   admin treats those as 'aesthetic' when the intake was completed.
--
-- Encounter measurements (weight, BMI, circumferences, dose, dilution) need no
-- migration: they live in clinical_history.procedures_detail.weight_loss.

-- glp1_screening: optional GLP-1 safety screening + habits from the
--   weight-loss track's screening step: { answers: { mtc_men2: true, … },
--   goal_weight, activity, alcohol }. Only answered questions are stored.
--
-- Safe to run more than once.

alter table public.admission_history
    add column if not exists weight_loss_history jsonb,
    add column if not exists intake_tracks text[],
    add column if not exists glp1_screening jsonb;
