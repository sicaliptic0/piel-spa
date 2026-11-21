-- iPhone Shortcut ("Gasto Piel") tokens. Each partner's phone gets its own token;
-- only its SHA-256 is stored. The gasto-atajo edge function checks it with the
-- service role and records the expense as that partner.
create table if not exists public.acct_shortcut_tokens (
    id uuid primary key default gen_random_uuid(),
    token_hash text not null unique,
    user_id uuid not null,                 -- admin who created it; expenses are created_by this user
    partner text not null check (partner in ('Freddy', 'Samuel', 'LLC')),
    default_account text,
    label text,
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz
);
alter table public.acct_shortcut_tokens enable row level security;
drop policy if exists "admin_all_acct_shortcut_tokens" on public.acct_shortcut_tokens;
create policy "admin_all_acct_shortcut_tokens" on public.acct_shortcut_tokens for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
