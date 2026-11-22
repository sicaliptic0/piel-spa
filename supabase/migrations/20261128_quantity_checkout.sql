begin;

alter table public.sale_services
    add column unit_price numeric(10,2) check (unit_price > 0),
    add column quantity_source text check (quantity_source in ('manual', 'fillers', 'neuromodulators')),
    add column inventory_product_id uuid references public.sale_products(id),
    add column volume_tiers jsonb not null default '[]',
    add column courtesy_min integer check (courtesy_min > 0),
    add column courtesy_percent numeric(5,2) check (courtesy_percent between 0 and 100),
    add constraint sale_services_quantity_setup check (
        (unit_price is null and quantity_source is null) or (unit_price is not null and quantity_source is not null)
    );

alter table public.payments
    add column service_quantity integer check (service_quantity > 0),
    add column unit_price_at_sale numeric(10,2) check (unit_price_at_sale > 0),
    add column discount_detail jsonb,
    add column product_lines jsonb,
    add column inventory_product_at_sale uuid references public.sale_products(id);

insert into public.sale_services (billing_code, name, category, unit, status, unit_price, quantity_source, volume_tiers, courtesy_min, courtesy_percent)
values ('ARMONIZACION', 'Armonización facial con ácido hialurónico', 'Pérdida de volumen', 'jeringa', 'assessment', 450, 'fillers',
        '[{"min":4,"percent":10},{"min":7,"percent":15},{"min":11,"percent":20}]', 4, 35)
on conflict (billing_code) do nothing;

-- Historical service references still point to their original catalog rows.
update public.sale_services set active = false, updated_at = now()
where code in ('RD-01', 'RD-02', 'RD-03', 'RD-04', 'RD-05') and active;

create function public.validate_quantity_checkout()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
    svc public.sale_services%rowtype;
    saved_quantity text;
    volume_percent numeric;
    courtesy_percent numeric;
    volume_discount numeric;
    expected_discount numeric;
    item record;
begin
    if new.service_catalog_code is not null then
        select * into svc from public.sale_services where code = new.service_catalog_code;
        if svc.unit_price is not null and new.service_quantity is null then
            raise exception 'Este servicio requiere registrar la cantidad.';
        end if;
    end if;
    new.inventory_product_at_sale := null;
    if new.service_quantity is not null then
        if not coalesce(svc.active, false) or svc.unit_price is null or new.unit_price_at_sale is distinct from svc.unit_price
            or new.amount is distinct from round(svc.unit_price * new.service_quantity, 2) or new.friend_coupon then
            raise exception 'Cambió el precio del servicio o el descuento. Reabre Cobros.';
        end if;
        select coalesce(procedures_detail #>> array['catalog_services', svc.code, 'qty'],
                        procedures_detail #>> array[svc.quantity_source, 'qty']) into saved_quantity
        from public.clinical_history where id = new.encounter_id and patient_id = new.patient_id;
        if svc.quantity_source <> 'manual' or saved_quantity is not null then
            if saved_quantity is null or saved_quantity !~ '^[0-9]+([.]0+)?$'
                or saved_quantity::numeric <> new.service_quantity then
                raise exception 'La cantidad debe coincidir con las unidades registradas en el encuentro.';
            end if;
        end if;
        select coalesce((select tier.percent from jsonb_to_recordset(svc.volume_tiers) as tier(min integer, percent numeric)
                         where tier.min <= new.service_quantity order by tier.min desc limit 1), 0)
        into volume_percent;
        courtesy_percent := coalesce((new.discount_detail->>'courtesy_percent')::numeric, 0);
        if courtesy_percent <> 0 and (svc.courtesy_min is null or new.service_quantity < svc.courtesy_min
           or courtesy_percent is distinct from svc.courtesy_percent) then
            raise exception 'La cortesía no está disponible para esta cantidad.';
        end if;
        volume_discount := round(new.amount * volume_percent / 100, 2);
        expected_discount := volume_discount + round((new.amount - volume_discount) * courtesy_percent / 100, 2);
        if new.discount is distinct from expected_discount then
            raise exception 'El descuento cambió. Reabre Cobros para recalcularlo.';
        end if;
        new.inventory_product_at_sale := svc.inventory_product_id;
    end if;

    if new.product_lines is not null then
        if exists (select 1 from jsonb_to_recordset(new.product_lines)
            as line(product_id uuid, quantity integer, unit_price numeric, name text)
            where line.quantity is null or line.quantity < 1 or line.unit_price is null or line.unit_price <= 0
                or coalesce(btrim(line.name), '') = '') then
            raise exception 'Revisa las cantidades, nombres y precios de los productos.';
        end if;
        if new.product_amount is distinct from coalesce((select sum(round(line.quantity * line.unit_price, 2))
            from jsonb_to_recordset(new.product_lines) as line(quantity integer, unit_price numeric)), 0) then
            raise exception 'El subtotal de productos no coincide.';
        end if;
    end if;

    -- In the same transaction as the payment, aggregate retail and clinical use.
    for item in
        select product_id, sum(quantity) as quantity from (
            select line.product_id, line.quantity from jsonb_to_recordset(coalesce(new.product_lines, '[]'))
                as line(product_id uuid, quantity integer)
            union all
            select new.inventory_product_at_sale, new.service_quantity
        ) tracked where product_id is not null group by product_id order by product_id
    loop
        update public.sale_products set stock_qty = (stock_qty - item.quantity)::integer, updated_at = now()
        where id = item.product_id and active and stock_qty >= item.quantity
            and (expires_on is null or expires_on >= new.paid_on);
        if not found then
            raise exception 'Un producto está vencido, inactivo o no tiene stock suficiente. Actualiza Cobros.';
        end if;
    end loop;
    return new;
end;
$$;

create trigger payments_quantity_checkout
before insert on public.payments
for each row execute function public.validate_quantity_checkout();

notify pgrst, 'reload schema';
commit;
