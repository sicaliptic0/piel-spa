-- Products the patient marks as "Ya lo tengo" in the portal (dashboard.html), per routine.
create table if not exists public.skincare_purchases (
    routine_id  uuid not null references public.skincare_routines (id) on delete cascade,
    product_id  text not null,
    patient_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
    created_at  timestamptz not null default now(),
    primary key (routine_id, product_id)
);
alter table public.skincare_purchases enable row level security;

-- The patient manages only their own marks, on their own published routines.
drop policy if exists "patient_own_skincare_purchases" on public.skincare_purchases;
create policy "patient_own_skincare_purchases" on public.skincare_purchases
    for all to authenticated
    using (patient_id = auth.uid()
           and exists (select 1 from public.skincare_routines r where r.id = routine_id and r.patient_id = auth.uid() and r.published))
    with check (patient_id = auth.uid()
           and exists (select 1 from public.skincare_routines r where r.id = routine_id and r.patient_id = auth.uid() and r.published));

-- Staff can see what each patient already has.
drop policy if exists "admin_all_skincare_purchases" on public.skincare_purchases;
create policy "admin_all_skincare_purchases" on public.skincare_purchases
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
