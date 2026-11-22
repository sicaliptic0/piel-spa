begin;

alter table public.payments add column service_lines jsonb
    check (service_lines is null or jsonb_typeof(service_lines) = 'array');

-- Restore the two fixed-price fillers under their existing catalog IDs and prices.
update public.sale_services set active = true, updated_at = now()
where code in ('RD-01', 'RD-02') and not active;

-- The original trigger remains responsible for existing single-service and product-only clients.
drop trigger payments_quantity_checkout on public.payments;
create trigger payments_quantity_checkout
before insert on public.payments for each row when (new.service_lines is null)
execute function public.validate_quantity_checkout();

create function public.validate_multi_service_checkout()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
    encounter_detail jsonb;
    normalized jsonb := '[]';
    line record;
    svc public.sale_services%rowtype;
    saved_quantity text;
    volume numeric;
    courtesy numeric;
    gross numeric := 0;
    discounts numeric := 0;
    item record;
begin
    if new.encounter_id is null or new.patient_id is null or new.service_catalog_code is not null
        or new.service_quantity is not null or new.friend_coupon
        or jsonb_array_length(new.service_lines) not between 1 and 100 then
        raise exception 'Selecciona los servicios registrados en el encuentro.';
    end if;

    select procedures_detail into encounter_detail from public.clinical_history
    where id = new.encounter_id and patient_id = new.patient_id for share;
    if not found then raise exception 'El encuentro no corresponde al paciente.'; end if;

    for line in select * from jsonb_to_recordset(new.service_lines)
        as entry(service_id text, quantity integer, unit_price numeric, amount numeric, discount numeric, courtesy_percent numeric)
    loop
        select * into svc from public.sale_services where code = line.service_id and active and status in ('available', 'assessment') for share;
        if not found or line.quantity is null or line.quantity not between 1 and 100000 or line.unit_price is null
            or line.unit_price < 0 or line.amount is distinct from round(line.unit_price * line.quantity, 2)
            or exists (select 1 from jsonb_array_elements(normalized) entry where entry->>'service_id' = line.service_id) then
            raise exception 'Hay un servicio duplicado, no disponible o con datos inválidos.';
        end if;
        if encounter_detail ? 'catalog_services' and not (encounter_detail->'catalog_services' ? svc.code) then
            raise exception 'El servicio debe estar marcado en el encuentro.';
        end if;
        volume := 0;
        courtesy := 0;
        if svc.unit_price is not null then
            saved_quantity := coalesce(encounter_detail #>> array['catalog_services', svc.code, 'qty'],
                                       encounter_detail #>> array[svc.quantity_source, 'qty']);
            if saved_quantity is null or saved_quantity !~ '^[0-9]+([.]0+)?$'
                or saved_quantity::numeric <> line.quantity or line.unit_price is distinct from svc.unit_price then
                raise exception 'La cantidad o tarifa no coincide con el encuentro y el catálogo.';
            end if;
            select coalesce((select round(line.amount * t.percent / 100, 2)
                from jsonb_to_recordset(svc.volume_tiers) t(min integer, percent numeric)
                where t.min <= line.quantity order by t.min desc limit 1), 0) into volume;
            if coalesce(line.courtesy_percent, 0) <> 0 then
                if svc.courtesy_min is null or line.quantity < svc.courtesy_min
                    or line.courtesy_percent is distinct from svc.courtesy_percent then
                    raise exception 'La cortesía no está disponible para este servicio.';
                end if;
                courtesy := round((line.amount - volume) * svc.courtesy_percent / 100, 2);
            end if;
        else
            if line.quantity <> 1 or coalesce(line.courtesy_percent, 0) <> 0 then
                raise exception 'El servicio de precio fijo debe tener una unidad.';
            end if;
            if coalesce(line.discount, 0) <> 0 and svc.sale_price = line.amount and svc.promo_price < svc.sale_price then
                volume := svc.sale_price - svc.promo_price;
            end if;
        end if;
        if line.discount is distinct from (volume + courtesy) then
            raise exception 'El descuento no coincide con la configuración del servicio.';
        end if;
        gross := gross + line.amount;
        discounts := discounts + line.discount;
        normalized := normalized || jsonb_build_array(jsonb_build_object(
            'service_id', svc.code, 'billing_code', svc.billing_code, 'name', svc.name, 'category', svc.category, 'unit', svc.unit,
            'quantity', line.quantity, 'unit_price', line.unit_price, 'amount', line.amount, 'discount', line.discount,
            'volume_discount', volume, 'courtesy_discount', courtesy,
            'inventory_product_id', case when svc.unit_price is not null then svc.inventory_product_id end
        ));
    end loop;
    if new.amount is distinct from gross or new.discount is distinct from discounts then
        raise exception 'Los totales de servicios no coinciden.';
    end if;

    if exists (select 1 from jsonb_to_recordset(coalesce(new.product_lines, '[]'))
        as entry(quantity integer, unit_price numeric, name text)
        where entry.quantity is null or entry.quantity < 1 or entry.unit_price is null or entry.unit_price <= 0 or coalesce(btrim(entry.name), '') = '')
        or new.product_amount is distinct from coalesce((select sum(round(entry.quantity * entry.unit_price, 2))
            from jsonb_to_recordset(coalesce(new.product_lines, '[]')) as entry(quantity integer, unit_price numeric)), 0) then
        raise exception 'Los productos o su subtotal no coinciden.';
    end if;
    for item in
        select product_id, sum(quantity) as quantity from (
            select entry.product_id, entry.quantity from jsonb_to_recordset(coalesce(new.product_lines, '[]'))
                as entry(product_id uuid, quantity integer)
            union all
            select entry.inventory_product_id, entry.quantity from jsonb_to_recordset(normalized)
                as entry(inventory_product_id uuid, quantity integer)
        ) tracked where product_id is not null group by product_id order by product_id
    loop
        update public.sale_products set stock_qty = (stock_qty - item.quantity)::integer, updated_at = now()
        where id = item.product_id and active and stock_qty >= item.quantity and (expires_on is null or expires_on >= new.paid_on);
        if not found then raise exception 'Stock insuficiente, producto inactivo o vencido. Actualiza Cobros.'; end if;
    end loop;
    new.service_lines := normalized;
    return new;
end;
$$;

create trigger payments_multi_service_checkout
before insert on public.payments for each row when (new.service_lines is not null)
execute function public.validate_multi_service_checkout();

-- Keep one income row per payment and attach machine-readable line details.
do $migration$
declare
    definition text := pg_get_functiondef('public.accounting_export(text)'::regprocedure);
    original constant text := 'from public.acct_income i where i.deleted_at is null';
    paid constant text := 'from public.payments p left join public.sale_services svc on svc.code = p.service_catalog_code) x)';
    old_code constant text := 'coalesce(svc.billing_code, p.service_code_snapshot, p.service_catalog_code)';
begin
    if position(original in definition) = 0 or position(paid in definition) = 0 or position(old_code in definition) = 0 then
        raise exception 'Unexpected accounting_export definition';
    end if;
    definition := replace(definition, old_code, 'coalesce(details.codes, svc.billing_code, p.service_code_snapshot, p.service_catalog_code)');
    definition := replace(definition, original, ', null::uuid as cobro_id, null::jsonb as detalle_servicios ' || original);
    definition := replace(definition, paid, $details$
        , p.id,
        coalesce(details.lines, case when p.service_catalog_code is not null then jsonb_build_array(jsonb_build_object(
            'billing_code', coalesce(svc.billing_code, p.service_code_snapshot, p.service_catalog_code),
            'name', coalesce(p.service_desc, svc.name, p.category), 'category', p.category, 'unit', svc.unit,
            'quantity', coalesce(p.service_quantity,1), 'unit_price', coalesce(p.unit_price_at_sale,p.amount),
            'amount', p.amount, 'discount', p.discount
        )) end)
        from public.payments p left join public.sale_services svc on svc.code = p.service_catalog_code
        left join lateral (
            select string_agg(coalesce(current_service.billing_code, entry.line->>'billing_code'), ' · ' order by entry.position) as codes,
                jsonb_agg(entry.line || jsonb_build_object('billing_code', coalesce(current_service.billing_code, entry.line->>'billing_code'))
                          order by entry.position) as lines
            from jsonb_array_elements(coalesce(p.service_lines, '[]')) with ordinality as entry(line,position)
            left join public.sale_services current_service on current_service.code = entry.line->>'service_id'
        ) details on true) x)$details$);
    execute definition;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
