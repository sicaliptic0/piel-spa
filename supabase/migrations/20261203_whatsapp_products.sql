alter table public.sale_products
    add column if not exists bot_visible boolean not null default false,
    add column if not exists location text
        check (location in ('piel_spa', 'divine_bliss'));

alter table public.wa_settings
    add column if not exists promo_ends_on date,
    add column if not exists product_promo_percent numeric(5,2) not null default 0
        check (product_promo_percent between 0 and 100),
    add column if not exists product_promo_ends_on date;

update public.wa_settings
set product_promo_percent = 15, product_promo_ends_on = '2026-11-29',
    promo_ends_on = case when concat_ws(' ', promo_text, promo_text_en) ilike '%black friday%'
        then coalesce(promo_ends_on, date '2026-11-29') else promo_ends_on end
where id = 1 and product_promo_ends_on is null;

notify pgrst, 'reload schema';
