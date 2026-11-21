-- Contabilidad, part 2:
--   * categories from the original Sheet (setup, payroll, utilities, biomedical waste)
--   * fixed monthly expenses ("Gastos fijos") that create themselves each month
--   * accounting_export(): read-only feed for the Google Sheet (tools/contabilidad-sheets-sync.gs),
--     unlocked by its own key in private.sync_tokens; admins read the key with accounting_sync_key().

insert into public.acct_categories (name, kind, form_line, note, sort) values
    ('Gastos de inicio (setup)', 'Gasto operativo', 'Line 21 (startup Sec. 195)', 'Constitución, permisos y gastos antes de abrir.', 0),
    ('Nómina', 'Gasto operativo', 'Line 9 Salaries and wages', 'Empleados. Lo que reciben los socios no es nómina.', 5),
    ('Servicios públicos', 'Gasto operativo', 'Line 21 Other deductions', 'Luz, agua, gas.', 8),
    ('Desechos biomédicos', 'Gasto operativo', 'Line 21 Other deductions', null, 16)
on conflict (name) do nothing;

-- ---------- Fixed monthly expenses ----------
create table if not exists public.acct_recurring (
    id uuid primary key default gen_random_uuid(),
    description text not null,
    vendor text,
    category text not null references public.acct_categories (name) on update cascade,
    amount numeric(10, 2) not null check (amount > 0),
    day_of_month int not null default 1 check (day_of_month between 1 and 31),
    paid_by text not null default 'LLC' check (paid_by in ('LLC', 'Freddy', 'Samuel', 'Ambos (50/50)')),
    account text,
    starts_on date not null default current_date,
    ends_on date,
    active boolean not null default true,
    note text,
    created_by uuid,
    created_at timestamptz not null default now()
);
alter table public.acct_recurring enable row level security;
drop policy if exists "admin_all_acct_recurring" on public.acct_recurring;
create policy "admin_all_acct_recurring" on public.acct_recurring for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

alter table public.acct_expenses add column if not exists recurring_id uuid references public.acct_recurring (id) on delete set null;
alter table public.acct_expenses add column if not exists recurring_month text;   -- 'YYYY-MM'
do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'acct_expenses_recurring_once') then
        alter table public.acct_expenses add constraint acct_expenses_recurring_once unique (recurring_id, recurring_month);
    end if;
end $$;
alter table public.acct_expenses drop constraint if exists acct_expenses_source_check;
alter table public.acct_expenses add constraint acct_expenses_source_check check (source in ('libro', 'admin', 'telefono', 'cobros', 'fijo'));

-- Creates the month's row for every active fixed expense whose day has arrived (New York time).
-- A row deleted by hand is not created again (the unique key still holds it).
create or replace function private.acct_generate_recurring_core()
returns int language plpgsql security definer set search_path = public as $$
declare
    r record; m date; d date; n int := 0;
    today date := (now() at time zone 'America/New_York')::date;
begin
    for r in select * from public.acct_recurring where active loop
        m := date_trunc('month', r.starts_on)::date;
        while m <= date_trunc('month', today)::date loop
            exit when r.ends_on is not null and m > r.ends_on;
            d := m + (least(r.day_of_month, extract(day from (m + interval '1 month' - interval '1 day'))::int) - 1);
            if d <= today and d >= r.starts_on then
                insert into public.acct_expenses (spent_on, description, vendor, category, ledger, amount, account, paid_by, reimb_status,
                                                  note, source, recurring_id, recurring_month, created_by)
                values (d, r.description, r.vendor, r.category, 'LLC', r.amount, r.account, r.paid_by,
                        case when r.paid_by = 'LLC' then 'No aplica (pagó la LLC)' else 'Pendiente' end,
                        'Gasto fijo mensual. Ajusta el monto si ese mes fue distinto.', 'fijo', r.id, to_char(m, 'YYYY-MM'), r.created_by)
                on conflict (recurring_id, recurring_month) do nothing;
                if found then n := n + 1; end if;
            end if;
            m := (m + interval '1 month')::date;
        end loop;
    end loop;
    return n;
end $$;
revoke all on function private.acct_generate_recurring_core() from public, anon, authenticated;

create or replace function public.acct_generate_recurring()
returns int language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
    return private.acct_generate_recurring_core();
end $$;
revoke all on function public.acct_generate_recurring() from public, anon;
grant execute on function public.acct_generate_recurring() to authenticated;

-- ---------- Google Sheet feed ----------
insert into private.sync_tokens (name, token)
values ('contabilidad_sheets', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create or replace function public.accounting_sync_key()
returns text language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
    return (select token from private.sync_tokens where name = 'contabilidad_sheets');
end $$;
revoke all on function public.accounting_sync_key() from public, anon;
grant execute on function public.accounting_sync_key() to authenticated;

create or replace function public.accounting_export(p_token text)
returns json language plpgsql security definer set search_path = public as $$
begin
    if p_token is null or not exists (select 1 from private.sync_tokens where name = 'contabilidad_sheets' and token = p_token) then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    perform private.acct_generate_recurring_core();
    return json_build_object(
        'generated_at', now(),
        'settings', (select row_to_json(s) from public.acct_settings s where id = 1),
        'categories', (select coalesce(json_agg(c order by c.sort, c.name), '[]') from public.acct_categories c),
        'expenses', (select coalesce(json_agg(json_build_object(
            'fecha', e.spent_on, 'descripcion', e.description, 'proveedor', e.vendor, 'categoria', e.category, 'libro', e.ledger,
            'monto', e.amount, 'cuenta', e.account, 'pagado_por', e.paid_by, 'estado', e.reimb_status, 'fecha_reembolso', e.reimbursed_on,
            'nota', e.note, 'origen', e.source, 'recibo', e.receipt_path is not null) order by e.spent_on), '[]')
            from public.acct_expenses e where e.deleted_at is null),
        'movements', (select coalesce(json_agg(json_build_object(
            'fecha', m.moved_on, 'socio', m.partner, 'tipo', m.kind, 'monto', m.amount, 'concepto', m.concept, 'confirmado', m.confirmed,
            'nota', replace(coalesce(m.note, ''), ' [libro]', '')) order by m.moved_on), '[]')
            from public.acct_partner_movements m where m.deleted_at is null),
        'income', (select coalesce(json_agg(x order by x.fecha), '[]') from (
            select i.received_on as fecha, i.client as cliente, i.service as servicio, i.category as categoria, i.method as metodo,
                   i.amount as monto, 0::numeric as impuesto, 0::numeric as recargo, i.amount as total, i.ledger as libro,
                   false as anulado, 'Libro original' as origen, i.note as nota
            from public.acct_income i where i.deleted_at is null
            union all
            select p.paid_on, p.patient_name, concat_ws(' + ', p.category, p.product_desc), coalesce(p.category, 'Sin categoría'), p.method,
                   p.amount - p.discount + p.product_amount, p.tax, p.surcharge, p.total, p.ledger,
                   p.voided_at is not null, 'Cobros', p.notes
            from public.payments p) x),
        'recurring', (select coalesce(json_agg(json_build_object(
            'descripcion', r.description, 'proveedor', r.vendor, 'categoria', r.category, 'monto', r.amount, 'dia', r.day_of_month,
            'pagado_por', r.paid_by, 'cuenta', r.account, 'desde', r.starts_on, 'hasta', r.ends_on, 'activo', r.active) order by r.description), '[]')
            from public.acct_recurring r)
    );
end $$;
revoke all on function public.accounting_export(text) from public;
grant execute on function public.accounting_export(text) to anon, authenticated;
