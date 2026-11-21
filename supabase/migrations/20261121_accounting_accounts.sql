-- Cards and accounts for "Cuenta / tarjeta". "Otra…" in the forms adds a row here,
-- so a new card stays in the list for everyone.
create table if not exists public.acct_accounts (
    name text primary key,
    sort int not null default 100,
    created_by uuid,
    created_at timestamptz not null default now()
);
alter table public.acct_accounts enable row level security;
drop policy if exists "admin_all_acct_accounts" on public.acct_accounts;
create policy "admin_all_acct_accounts" on public.acct_accounts for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

insert into public.acct_accounts (name, sort) values
    ('Chase Ink Business', 1), ('Amex Business', 2), ('Débito Chase Business', 3), ('Cuenta LLC (Zelle/cheque)', 4),
    ('Tarjeta Chase', 5), ('BofA Mastercard', 6), ('BofA Travel', 7), ('Visa (sin identificar)', 8), ('Tarjeta personal', 9),
    ('Zelle / transferencia personal', 10), ('Efectivo', 11), ('Cheque', 12), ('Sin dato', 99)
on conflict (name) do nothing;
