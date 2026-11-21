-- Contabilidad: expenses, partner movements, other income, settings, and the
-- extra Cobros fields (service vs product tax, card surcharge, QuickAccept fee).
-- Admin-only everywhere (public.is_admin()). Additive: nothing existing is dropped.

-- ---------- Settings (one row) ----------
create table if not exists public.acct_settings (
    id int primary key default 1 check (id = 1),
    tax_services numeric(6, 4) not null default 0.045,    -- NYC tax on aesthetic services (por confirmar)
    tax_products numeric(6, 4) not null default 0.08875,  -- NYC sales tax on products (por confirmar)
    services_taxed boolean not null default true,
    surcharge_credit numeric(6, 4) not null default 0.026, -- passed to the client on credit cards only
    processor text not null default 'Chase QuickAccept',
    fee_pct numeric(6, 4) not null default 0.026,
    fee_fixed numeric(6, 2) not null default 0.10,
    loan_rate numeric(6, 4) not null default 0,           -- annual, for partner loans
    share_freddy numeric(4, 3) not null default 0.5,
    share_samuel numeric(4, 3) not null default 0.5,
    updated_at timestamptz not null default now()
);
insert into public.acct_settings (id) values (1) on conflict (id) do nothing;

-- ---------- Expense categories ----------
create table if not exists public.acct_categories (
    name text primary key,
    kind text not null check (kind in ('Costo de ventas', 'Gasto operativo', 'Activo', 'No es gasto', 'No deducible', 'Fuera de la LLC', 'Revisar')),
    form_line text,
    note text,
    sort int not null default 0
);
insert into public.acct_categories (name, kind, form_line, note, sort) values
    ('Insumos y productos de tratamiento', 'Costo de ventas', 'Form 1125-A / Line 2', 'Lo que se usa o se gasta en cada tratamiento.', 1),
    ('Producto para reventa', 'Costo de ventas', 'Form 1125-A / Line 2', 'Producto que se vende al cliente. La venta lleva sales tax.', 2),
    ('Equipo (activo)', 'Activo', 'Form 4562 (Sec. 179 o depreciación)', 'Equipo durable de valor alto.', 3),
    ('Equipo menor y mobiliario', 'Gasto operativo', 'Line 21 Other deductions', 'Bajo valor (regla de minimis de $2,500 por artículo).', 4),
    ('Alquiler de cabina', 'Gasto operativo', 'Line 13 Rent', null, 5),
    ('Depósito de garantía', 'No es gasto', 'Schedule L (activo)', 'Se recupera al terminar el contrato.', 6),
    ('Software y suscripciones', 'Gasto operativo', 'Line 21 Other deductions', null, 7),
    ('Teléfono e internet', 'Gasto operativo', 'Line 21 Other deductions', null, 8),
    ('Seguros', 'Gasto operativo', 'Line 20 / 21', null, 9),
    ('Licencias, trámites y legal', 'Gasto operativo', 'Line 21 (startup Sec. 195 si es antes de abrir)', null, 10),
    ('Envíos y aranceles de importación', 'Costo de ventas', 'Form 1125-A / Line 2', 'Flete de insumos importados.', 11),
    ('Transporte', 'Gasto operativo', 'Line 21 Other deductions', null, 12),
    ('Comidas de negocio (50%)', 'Gasto operativo', 'Line 21 (50% deducible)', 'Solo el 50% es deducible.', 13),
    ('Educación y cursos', 'Gasto operativo', 'Line 21 Other deductions', null, 14),
    ('Uniformes', 'Gasto operativo', 'Line 21 Other deductions', 'Solo ropa de trabajo que no sirve para uso diario.', 15),
    ('Limpieza y suministros', 'Gasto operativo', 'Line 21 Other deductions', null, 16),
    ('Publicidad y marketing', 'Gasto operativo', 'Line 21 Other deductions', null, 17),
    ('Comisiones bancarias y de tarjeta', 'Gasto operativo', 'Line 21 Other deductions', null, 18),
    ('Multas y penalidades', 'No deducible', 'No va en el 1065', 'IRC 162(f).', 19),
    ('Pagos a socios por jornada NJ', 'Fuera de la LLC', 'No va en el 1065', 'Jornadas de New Jersey: fuera de la LLC.', 20),
    ('Revisar', 'Revisar', null, 'Falta decidir si es del negocio o personal.', 21)
on conflict (name) do nothing;

-- ---------- Expenses ----------
create table if not exists public.acct_expenses (
    id uuid primary key default gen_random_uuid(),
    spent_on date not null,
    description text not null,
    vendor text,
    category text not null references public.acct_categories (name) on update cascade,
    ledger text not null default 'LLC' check (ledger in ('LLC', 'NJ (fuera de la LLC)', 'Revisar')),
    amount numeric(10, 2) not null check (amount >= 0),
    account text,                                   -- card or account used
    paid_by text not null check (paid_by in ('LLC', 'Freddy', 'Samuel', 'Ambos (50/50)', 'Otra persona', 'Sin dato')),
    reimb_status text not null check (reimb_status in ('Pendiente', 'Reembolsado', 'Aportado como capital', 'No aplica (pagó la LLC)', 'Sin dato')),
    reimbursed_on date,
    note text,
    receipt_path text,                              -- file in the private "receipts" bucket
    payment_id uuid references public.payments (id) on delete set null,  -- card fee created from Cobros
    source text not null default 'admin' check (source in ('libro', 'admin', 'telefono', 'cobros')),
    created_by uuid,
    created_at timestamptz not null default now(),
    deleted_at timestamptz                          -- kept, but no longer counted
);
create index if not exists acct_expenses_spent_idx on public.acct_expenses (spent_on desc);
alter table public.acct_expenses enable row level security;
drop policy if exists "admin_all_acct_expenses" on public.acct_expenses;
create policy "admin_all_acct_expenses" on public.acct_expenses for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- ---------- Partner movements (capital, partner loans) ----------
create table if not exists public.acct_partner_movements (
    id uuid primary key default gen_random_uuid(),
    moved_on date not null,
    partner text not null check (partner in ('Freddy', 'Samuel', 'Ambos (50/50)')),
    kind text not null check (kind in ('Aporte de capital', 'Retiro de capital', 'Préstamo del socio', 'Pago de préstamo al socio')),
    amount numeric(10, 2) not null check (amount > 0),
    concept text not null,
    confirmed boolean not null default true,
    note text,
    created_by uuid,
    created_at timestamptz not null default now(),
    deleted_at timestamptz
);
create index if not exists acct_partner_movements_on_idx on public.acct_partner_movements (moved_on desc);
alter table public.acct_partner_movements enable row level security;
drop policy if exists "admin_all_acct_partner_movements" on public.acct_partner_movements;
create policy "admin_all_acct_partner_movements" on public.acct_partner_movements for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- ---------- Income that did not go through Cobros (history before it, bank bonus) ----------
create table if not exists public.acct_income (
    id uuid primary key default gen_random_uuid(),
    received_on date,                               -- null only for imported rows still missing a date
    client text not null,
    service text,
    category text,
    method text,
    amount numeric(10, 2),                          -- null only for imported rows still missing an amount
    ledger text not null default 'LLC' check (ledger in ('LLC', 'NJ (fuera de la LLC)', 'Revisar')),
    note text,
    source text not null default 'admin' check (source in ('libro', 'admin')),
    created_by uuid,
    created_at timestamptz not null default now(),
    deleted_at timestamptz
);
alter table public.acct_income enable row level security;
drop policy if exists "admin_all_acct_income" on public.acct_income;
create policy "admin_all_acct_income" on public.acct_income for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- ---------- Settings and categories: admin read/write ----------
alter table public.acct_settings enable row level security;
drop policy if exists "admin_all_acct_settings" on public.acct_settings;
create policy "admin_all_acct_settings" on public.acct_settings for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
alter table public.acct_categories enable row level security;
drop policy if exists "admin_all_acct_categories" on public.acct_categories;
create policy "admin_all_acct_categories" on public.acct_categories for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- ---------- Cobros: new fields ----------
alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check
    check (method in ('cash', 'transfer', 'zelle', 'debit', 'credit', 'cherry', 'check', 'other'));
alter table public.payments add column if not exists category text;                  -- Faciales B, Faciales R…
alter table public.payments add column if not exists ledger text not null default 'LLC'
    check (ledger in ('LLC', 'NJ (fuera de la LLC)'));
alter table public.payments add column if not exists service_tax numeric(10, 2) not null default 0;
alter table public.payments add column if not exists product_desc text;
alter table public.payments add column if not exists product_amount numeric(10, 2) not null default 0;
alter table public.payments add column if not exists product_tax numeric(10, 2) not null default 0;
alter table public.payments add column if not exists surcharge numeric(10, 2) not null default 0;
alter table public.payments add column if not exists processor_fee numeric(10, 2) not null default 0;
alter table public.payments add column if not exists card_last4 text;
alter table public.payments add column if not exists card_receipt text;
alter table public.payments add column if not exists reconciled_at timestamptz;

-- ---------- Receipt photos (private bucket) ----------
insert into storage.buckets (id, name, public) values ('receipts', 'receipts', false) on conflict (id) do nothing;
drop policy if exists "admin_read_receipts" on storage.objects;
create policy "admin_read_receipts" on storage.objects
    for select to authenticated using (bucket_id = 'receipts' and public.is_admin());
drop policy if exists "admin_upload_receipts" on storage.objects;
create policy "admin_upload_receipts" on storage.objects
    for insert to authenticated with check (bucket_id = 'receipts' and public.is_admin());
drop policy if exists "admin_delete_receipts" on storage.objects;
create policy "admin_delete_receipts" on storage.objects
    for delete to authenticated using (bucket_id = 'receipts' and public.is_admin());
