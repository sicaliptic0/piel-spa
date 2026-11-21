-- accounting_export(): each expense also says whether it is a fixed monthly expense ("fijo").
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
            'nota', e.note, 'origen', e.source, 'recibo', e.receipt_path is not null, 'fijo', e.recurring_id is not null) order by e.spent_on), '[]')
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
