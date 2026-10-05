-- Devices (phones/computers) where an admin turned on notifications from
-- "Mensajes" → Activar avisos. Edge functions send Web Push to each one;
-- devices the browser dropped are deleted automatically.

create table if not exists public.push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid(),
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    device text,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
);
alter table public.push_subscriptions enable row level security;

-- Each admin manages only their own devices.
drop policy if exists "admin_own_push_subscriptions" on public.push_subscriptions;
create policy "admin_own_push_subscriptions" on public.push_subscriptions
    for all to authenticated
    using (public.is_admin() and user_id = auth.uid())
    with check (public.is_admin() and user_id = auth.uid());
