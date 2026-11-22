-- "Productos y servicios" → Productos: what Piel Spa sells, with prices, stock and expiry.
-- Its own table (the skincare catalog stays the reference for routines); catalog_id links
-- a product to its catalog entry when there is one. Cobros sells from here.
create table if not exists public.sale_products (
    id uuid primary key default gen_random_uuid(),
    catalog_id text references public.skincare_products (id) on delete set null,
    brand text not null,
    name text not null,
    size text,
    category text,                         -- Protector solar, Sérum, Crema, …
    sku text,                              -- code or barcode
    supplier text,
    cost numeric(10, 2),                   -- what Piel Spa pays per unit
    suggested_price numeric(10, 2),        -- brand's retail price
    sale_price numeric(10, 2),             -- Piel Spa's price (used in Cobros)
    stock_qty int not null default 0,
    min_stock int,                         -- warn when stock reaches this
    expires_on date,                       -- nearest expiry of the units on hand
    lot text,
    sales_taxable boolean not null default true,
    notes text,
    active boolean not null default true,  -- false = removed from sale (kept for history)
    created_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
alter table public.sale_products enable row level security;
drop policy if exists "admin_all_sale_products" on public.sale_products;
create policy "admin_all_sale_products" on public.sale_products for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- Start from the catalog items already marked "sold at Piel Spa" (mesoestetic and Colorescience).
insert into public.sale_products (catalog_id, brand, name, size, category, supplier, cost, suggested_price, sale_price, stock_qty, sales_taxable)
select p.id, p.brand, p.name, p.size,
       case p.step when 'spf' then 'Protector solar' when 'serum' then 'Sérum' when 'moisturizer' then 'Crema'
                   when 'eye' then 'Contorno de ojos' when 'cleanser' then 'Limpiador' when 'double_cleanse' then 'Limpiador'
                   when 'weekly' then 'Mascarilla' else 'Tratamiento' end,
       case when p.brand ilike 'meso%' then 'DG Cosmetics (mesoestetic)' else p.brand end,
       p.cost_usd, p.price_usd, p.clinic_price_usd, coalesce(p.stock_qty, 0), coalesce(p.sales_taxable, true)
from public.skincare_products p
where p.in_stock and not exists (select 1 from public.sale_products s where s.catalog_id = p.id);
