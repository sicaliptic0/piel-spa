create or replace function public.change_sale_product_location(
    p_product_id uuid, p_destination text, p_quantity integer, p_move boolean
)
returns setof public.sale_products
language plpgsql
security invoker
set search_path = ''
as $$
declare
    source_product public.sale_products%rowtype;
    destination_product public.sale_products%rowtype;
    matches uuid[];
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Se requiere acceso de administrador' using errcode = '42501';
    end if;
    if p_destination is null or p_destination not in ('piel_spa', 'divine_bliss')
        or p_quantity is null or p_quantity < 1 or p_move is null then
        raise exception 'Elige una sede de destino y una cantidad entera mayor que cero.';
    end if;

    -- Serialize these operations, including the case where the destination has no row yet.
    perform pg_catalog.pg_advisory_xact_lock(261208, 1);
    select * into source_product from public.sale_products
    where id = p_product_id and active for update;
    if not found then raise exception 'El producto de origen ya no está disponible.'; end if;
    if source_product.location = p_destination then
        raise exception 'Elige una sede distinta a la de origen.';
    end if;
    if p_move and source_product.stock_qty < p_quantity then
        raise exception 'Solo quedan % unidades en el origen.', source_product.stock_qty;
    end if;

    select array_agg(p.id) into matches
    from public.sale_products p
    where p.active and p.location = p_destination
        and lower(btrim(p.brand)) = lower(btrim(source_product.brand))
        and case when nullif(btrim(source_product.sku), '') is not null then
            lower(btrim(p.sku)) = lower(btrim(source_product.sku))
        else
            nullif(btrim(p.sku), '') is null
            and lower(btrim(p.name)) = lower(btrim(source_product.name))
            and lower(btrim(coalesce(p.size, ''))) = lower(btrim(coalesce(source_product.size, '')))
        end;

    if cardinality(matches) > 1 then
        raise exception 'Hay varias fichas activas para este producto en el destino. Revisa esas fichas antes de mover stock.';
    end if;
    if matches is not null then
        if not p_move then raise exception 'Ya existe una ficha activa en esa sede. Edita su stock o usa Mover stock.'; end if;
        select * into destination_product from public.sale_products
        where id = matches[1] and active and location = p_destination for update;
        if not found then raise exception 'La ficha de destino cambió. Intenta de nuevo.'; end if;
        if destination_product.stock_qty > 0 and
            (destination_product.lot is distinct from source_product.lot
                or destination_product.expires_on is distinct from source_product.expires_on) then
            raise exception 'El lote o vencimiento difiere en el destino. Conserva las unidades en fichas separadas.';
        end if;
        update public.sale_products set
            stock_qty = stock_qty + p_quantity,
            lot = source_product.lot,
            expires_on = source_product.expires_on,
            updated_at = now()
        where id = destination_product.id returning * into destination_product;
    else
        insert into public.sale_products (
            catalog_id, brand, name, size, category, sku, supplier, cost, suggested_price, sale_price,
            promo_price, promo_percent, stock_qty, min_stock, expires_on, lot, sales_taxable, notes, location, created_by
        ) values (
            source_product.catalog_id, source_product.brand, source_product.name, source_product.size, source_product.category,
            source_product.sku, source_product.supplier, source_product.cost, source_product.suggested_price, source_product.sale_price,
            source_product.promo_price, source_product.promo_percent, p_quantity, source_product.min_stock,
            case when p_move then source_product.expires_on end,
            case when p_move then source_product.lot end, source_product.sales_taxable, source_product.notes, p_destination, auth.uid()
        ) returning * into destination_product;
    end if;

    if p_move then
        update public.sale_products set stock_qty = stock_qty - p_quantity, updated_at = now()
        where id = source_product.id returning * into source_product;
        return next source_product;
    end if;
    return next destination_product;
end;
$$;

revoke execute on function public.change_sale_product_location(uuid, text, integer, boolean) from public, anon;
grant execute on function public.change_sale_product_location(uuid, text, integer, boolean) to authenticated;
notify pgrst, 'reload schema';
