begin;

create or replace function public.compute_service_promo_price()
returns trigger language plpgsql set search_path = '' as $$
declare
    base numeric := coalesce(new.unit_price, new.sale_price);
    final_price numeric;
begin
    if new.promo_percent is not null then
        final_price := round(base * (100 - new.promo_percent) / 100, 2);
        if base is null or final_price >= base then
            raise exception 'El precio promocional debe quedar por debajo del precio base.';
        end if;
        new.promo_price := final_price;
    elsif tg_op = 'UPDATE' and old.promo_percent is not null then
        new.promo_price := null;
    end if;
    return new;
end;
$$;

update public.sale_services
set promo_price = round(coalesce(unit_price, sale_price) * (100 - promo_percent) / 100, 2),
    updated_at = now()
where promo_percent is not null
    and promo_price is distinct from round(coalesce(unit_price, sale_price) * (100 - promo_percent) / 100, 2);

commit;
