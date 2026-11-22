begin;

create or replace function public.validate_multi_service_checkout()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
    encounter_detail jsonb;
    normalized jsonb := '[]';
    line record;
    svc public.sale_services%rowtype;
    saved_quantity text;
    pricing jsonb;
    selected_subtotal numeric;
    price_discount numeric;
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
        price_discount := 0;
        selected_subtotal := line.amount;
        pricing := encounter_detail #> array['catalog_services', svc.code, 'pricing'];
        if svc.code = 'CONSULTA' and jsonb_array_length(new.service_lines) > 1 then
            if line.quantity <> 1 or line.amount <> 0 or coalesce(line.courtesy_percent, 0) <> 0 then
                raise exception 'La consulta va incluida cuando se cobra un tratamiento.';
            end if;
        elsif jsonb_typeof(pricing) = 'object' then
            saved_quantity := encounter_detail #>> array['catalog_services', svc.code, 'qty'];
            if saved_quantity is null or saved_quantity !~ '^[0-9]+([.]0+)?$' or saved_quantity::numeric <> line.quantity
                or coalesce(pricing->>'mode', '') not in ('regular','promo','manual')
                or line.unit_price is distinct from (pricing->>'regular_unit_price')::numeric
                or (pricing->>'unit_price')::numeric is null or (pricing->>'unit_price')::numeric not between 0 and line.unit_price
                or (pricing->>'mode' <> 'promo' and line.unit_price is distinct from (pricing->>'unit_price')::numeric) then
                raise exception 'La cantidad o tarifa no coincide con el encuentro.';
            end if;
            selected_subtotal := round((pricing->>'unit_price')::numeric * line.quantity, 2);
            price_discount := line.amount - selected_subtotal;
            if svc.unit_price is not null then
                select coalesce((select round(selected_subtotal * t.percent / 100, 2)
                    from jsonb_to_recordset(svc.volume_tiers) t(min integer, percent numeric)
                    where t.min <= line.quantity order by t.min desc limit 1), 0) into volume;
            end if;
            if coalesce(line.courtesy_percent, 0) <> 0 then
                if svc.unit_price is null or svc.courtesy_min is null or line.quantity < svc.courtesy_min
                    or line.courtesy_percent is distinct from svc.courtesy_percent then
                    raise exception 'La cortesía no está disponible para este servicio.';
                end if;
                courtesy := round((selected_subtotal - volume) * svc.courtesy_percent / 100, 2);
            end if;
        elsif svc.unit_price is not null then
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
        if line.discount is distinct from (price_discount + volume + courtesy) then
            raise exception 'El descuento no coincide con la configuración del servicio.';
        end if;
        gross := gross + line.amount;
        discounts := discounts + line.discount;
        normalized := normalized || jsonb_build_array(jsonb_build_object(
            'service_id', svc.code, 'billing_code', svc.billing_code, 'name', svc.name, 'category', svc.category, 'unit', svc.unit,
            'quantity', line.quantity, 'unit_price', line.unit_price, 'amount', line.amount, 'discount', line.discount,
            'price_discount', price_discount, 'volume_discount', volume, 'courtesy_discount', courtesy,
            'inventory_product_id', case when svc.unit_price is not null and not (svc.code = 'CONSULTA'
                and jsonb_array_length(new.service_lines) > 1) then svc.inventory_product_id end
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

notify pgrst, 'reload schema';
commit;
