begin;

alter table public.payments add column buyer_phone text;
alter table public.payments add constraint payments_guest_product_check check (
    buyer_phone is null or (
        buyer_phone ~ '^\+[0-9]{8,15}$'
        and patient_id is null and encounter_id is null and service_catalog_code is null
        and category is not distinct from 'Solo producto' and amount = 0
        and product_amount is not null and product_amount > 0 and not friend_coupon
    )
);

with ranked as (
    select code, (row_number() over (
        order by coalesce(array_position(array[
            'Consulta', 'Mantenimiento de mi piel', 'Manchas y melasma', 'Acné y brotes',
            'Textura y poros', 'Vello no deseado', 'Relajación y drenaje', 'Arrugas', 'Flacidez',
            'Luminosidad e hidratación', 'Pérdida de volumen', 'Ojeras'
        ], category), 99), category, sort_order, name, code
    ) - 1)::integer as position
    from public.sale_services
)
update public.sale_services as service
set sort_order = ranked.position, updated_at = now()
from ranked where service.code = ranked.code and service.sort_order <> ranked.position;

notify pgrst, 'reload schema';
commit;
