alter table public.sale_products
    add column if not exists promo_price numeric(10, 2) check (promo_price >= 0),
    add column if not exists promo_percent numeric(5, 2) check (promo_percent > 0 and promo_percent < 100);

create or replace function public.calculate_sale_product_promotion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    base_price numeric := coalesce(new.sale_price, new.suggested_price);
begin
    if new.promo_percent is not null then
        new.promo_price := round(base_price * (100 - new.promo_percent) / 100, 2);
        if new.promo_price is null or new.promo_price <= 0 or new.promo_price >= base_price then
            raise exception 'El descuento de «%» requiere un precio base válido y una oferta menor al precio base.', new.name;
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists calculate_sale_product_promotion on public.sale_products;
create trigger calculate_sale_product_promotion
before insert or update of sale_price, suggested_price, promo_price, promo_percent
on public.sale_products for each row
execute function public.calculate_sale_product_promotion();
