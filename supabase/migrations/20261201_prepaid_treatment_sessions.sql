begin;

alter table public.sale_services
    add column promo_percent numeric(9,6) check (promo_percent > 0 and promo_percent <= 100),
    add column package_session_price numeric(10,2),
    add column package_min_sessions integer,
    add constraint sale_services_package_setup check (
        (package_session_price is null and package_min_sessions is null)
        or (package_session_price > 0 and package_min_sessions between 2 and 1000
            and package_session_price is not null and package_min_sessions is not null
            and sale_price is not null and sale_price >= package_session_price and unit_price is null)
    );

update public.sale_services
set sale_price = 250, package_session_price = 200, package_min_sessions = 3, updated_at = now()
where code = 'NCTF';

update public.sale_services
set promo_percent = ceil((coalesce(unit_price, sale_price) - promo_price)
    * 100000000 / nullif(coalesce(unit_price, sale_price), 0)) / 1000000
where promo_price >= 0 and promo_price = trunc(promo_price)
    and promo_price < coalesce(unit_price, sale_price);

create function public.compute_service_promo_price()
returns trigger language plpgsql set search_path = '' as $$
declare
    base numeric := coalesce(new.unit_price, new.sale_price);
    final_price numeric;
begin
    if new.promo_percent is not null then
        final_price := ceil(base * (100 - new.promo_percent) / 100);
        if base is null or final_price >= base then
            raise exception 'El precio promocional debe quedar por debajo del precio base después del redondeo.';
        end if;
        new.promo_price := final_price;
    elsif tg_op = 'UPDATE' and old.promo_percent is not null then
        new.promo_price := null;
    end if;
    return new;
end;
$$;

create trigger sale_services_compute_promo before insert or update of promo_percent, promo_price, sale_price, unit_price
on public.sale_services for each row execute function public.compute_service_promo_price();

create table public.treatment_packages (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid references public.profiles(id) on delete set null,
    service_catalog_code text not null references public.sale_services(code),
    purchased integer not null check (purchased >= 0),
    used integer not null default 0 check (used >= 0 and used <= purchased),
    created_at timestamptz not null default now()
);
create index treatment_packages_patient on public.treatment_packages(patient_id, service_catalog_code, created_at);

create table public.treatment_package_purchases (
    payment_id uuid primary key references public.payments(id),
    package_id uuid not null references public.treatment_packages(id),
    sessions integer not null check (sessions > 0),
    unit_price numeric(10,2) not null check (unit_price > 0),
    voided_at timestamptz
);

create table public.treatment_package_uses (
    encounter_id uuid not null references public.clinical_history(id),
    package_id uuid not null references public.treatment_packages(id),
    created_at timestamptz not null default now(),
    primary key (encounter_id, package_id)
);
create index treatment_package_uses_by_package on public.treatment_package_uses(package_id);

alter table public.treatment_packages enable row level security;
alter table public.treatment_package_purchases enable row level security;
alter table public.treatment_package_uses enable row level security;
revoke all on public.treatment_packages, public.treatment_package_purchases, public.treatment_package_uses from anon, authenticated;
grant select on public.treatment_packages, public.treatment_package_purchases, public.treatment_package_uses to authenticated;
create policy treatment_packages_admin_read on public.treatment_packages for select to authenticated using (public.is_admin());
create policy treatment_package_purchases_admin_read on public.treatment_package_purchases for select to authenticated using (public.is_admin());
create policy treatment_package_uses_admin_read on public.treatment_package_uses for select to authenticated using (public.is_admin());

alter table public.payments
    add column package_sessions integer check (package_sessions between 1 and 1000),
    add column package_unit_price numeric(10,2) check (package_unit_price > 0),
    add constraint payments_package_fields check ((package_sessions is null) = (package_unit_price is null));

create function public.apply_treatment_package_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    svc public.sale_services%rowtype;
    credit public.treatment_package_purchases%rowtype;
    target uuid;
begin
    if tg_op = 'UPDATE' then
        if new.package_sessions is distinct from old.package_sessions or new.package_unit_price is distinct from old.package_unit_price
            or (new.patient_id is not null and new.patient_id is distinct from old.patient_id)
            or new.service_catalog_code is distinct from old.service_catalog_code
            or new.amount is distinct from old.amount or new.discount is distinct from old.discount then
            raise exception 'Los datos de una compra de sesiones registrada no se pueden modificar.';
        end if;
        if old.voided_at is not null and new.voided_at is null then raise exception 'Registra una nueva compra de sesiones.'; end if;
        if old.voided_at is null and new.voided_at is not null then
            select * into strict credit from public.treatment_package_purchases where payment_id = old.id;
            update public.treatment_packages set purchased = purchased - credit.sessions
            where id = credit.package_id and purchased - used >= credit.sessions;
            if not found then raise exception 'El saldo disponible es menor que las sesiones de esta compra. Revisa las sesiones ya utilizadas.'; end if;
            update public.treatment_package_purchases set voided_at = new.voided_at where payment_id = old.id;
        end if;
        return new;
    end if;
    if new.patient_id is null or new.encounter_id is not null or new.service_lines is not null or new.friend_coupon
        or new.voided_at is not null or new.service_quantity is not null or new.discount <> 0 then
        raise exception 'Registra el prepago por separado del encuentro y de descuentos del servicio.';
    end if;
    select * into svc from public.sale_services where code = new.service_catalog_code and active
        and status in ('available', 'assessment') for share;
    if not found or svc.package_session_price is null or new.package_unit_price is distinct from svc.package_session_price
        or new.amount is distinct from round(new.package_sessions * svc.package_session_price, 2) then
        raise exception 'La tarifa del paquete cambió. Vuelve a cargar Cobros.';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.patient_id::text || ':' || svc.code, 0));
    select id into target from public.treatment_packages
    where patient_id = new.patient_id and service_catalog_code = svc.code and purchased > used
    order by created_at, id limit 1 for update;
    if target is null then
        if new.package_sessions < svc.package_min_sessions then
            raise exception 'El paciente no tiene saldo activo. Aplica el mínimo de una compra nueva.';
        end if;
        insert into public.treatment_packages(patient_id, service_catalog_code, purchased)
            values(new.patient_id, svc.code, new.package_sessions) returning id into target;
    else
        update public.treatment_packages set purchased = purchased + new.package_sessions where id = target;
    end if;
    insert into public.treatment_package_purchases(payment_id, package_id, sessions, unit_price)
        values(new.id, target, new.package_sessions, new.package_unit_price);
    return new;
end;
$$;

create trigger treatment_package_payment_insert after insert on public.payments
for each row when (new.package_sessions is not null) execute function public.apply_treatment_package_payment();
create trigger treatment_package_payment_update after update on public.payments
for each row when (old.package_sessions is not null or new.package_sessions is not null) execute function public.apply_treatment_package_payment();

create function public.sync_treatment_package_uses()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    target uuid;
    visit uuid;
    detail jsonb := '{}';
    linked record;
begin
    if tg_op = 'DELETE' then
        visit := old.id;
    else
        visit := new.id;
        if jsonb_typeof(new.procedures_detail->'catalog_services') = 'object' then
            detail := new.procedures_detail->'catalog_services';
        end if;
    end if;

    -- Validate the requested package before changing the balance.
    for linked in select key as service, value->>'package_id' as package
        from jsonb_each(detail) where value->>'package_id' is not null order by value->>'package_id'
    loop
        target := linked.package::uuid;
        perform 1 from public.treatment_packages where id = target and patient_id = new.patient_id and service_catalog_code = linked.service for update;
        if not found or (detail->linked.service->>'qty')::integer is distinct from 1 then
            raise exception 'El paquete o la cantidad de la sesión no corresponde al encuentro.';
        end if;
        if exists (select 1 from public.payments p where p.encounter_id = visit and p.voided_at is null
            and (p.service_catalog_code = linked.service or exists (select 1 from jsonb_array_elements(coalesce(p.service_lines,'[]')) entry where entry->>'service_id' = linked.service))) then
            raise exception 'Este servicio ya tiene un cobro en el encuentro.';
        end if;
        if not exists (select 1 from public.treatment_package_uses where encounter_id = visit and package_id = target) then
            update public.treatment_packages set used = used + 1 where id = target and used < purchased;
            if not found then raise exception 'No quedan sesiones disponibles en este paquete.'; end if;
            insert into public.treatment_package_uses(encounter_id, package_id) values(visit, target);
        end if;
    end loop;
    for target in select package_id from public.treatment_package_uses u where u.encounter_id = visit
        and not exists (select 1 from jsonb_each(detail) entry where entry.value->>'package_id' = u.package_id::text)
        order by package_id
    loop
        update public.treatment_packages set used = used - 1 where id = target;
        delete from public.treatment_package_uses where encounter_id = visit and package_id = target;
    end loop;
    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;

create trigger treatment_package_encounter_save
after insert or update of procedures_detail, patient_id on public.clinical_history
for each row execute function public.sync_treatment_package_uses();
create trigger treatment_package_encounter_delete
before delete on public.clinical_history for each row execute function public.sync_treatment_package_uses();

create function public.block_redeemed_service_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    perform 1 from public.clinical_history where id = new.encounter_id for update;
    if exists (select 1 from public.treatment_package_uses u join public.treatment_packages t on t.id = u.package_id
        where u.encounter_id = new.encounter_id and (t.service_catalog_code = new.service_catalog_code
        or exists (select 1 from jsonb_array_elements(coalesce(new.service_lines,'[]')) entry where entry->>'service_id' = t.service_catalog_code))) then
        raise exception 'Ese servicio ya se cubrió con una sesión del paquete.';
    end if;
    return new;
end;
$$;
create trigger treatment_package_no_double_charge before insert on public.payments
for each row when (new.encounter_id is not null) execute function public.block_redeemed_service_payment();

revoke execute on function public.apply_treatment_package_payment(), public.sync_treatment_package_uses(),
    public.block_redeemed_service_payment() from public, anon, authenticated;

-- Still one income row per payment. Detail exports the purchased session count.
do $migration$
declare
    definition text := pg_get_functiondef('public.accounting_export(text)'::regprocedure);
    original constant text := 'coalesce(p.service_quantity,1)';
    compiled constant text := 'coalesce(p.unit_price_at_sale,p.amount)';
begin
    -- The same function exists in formatted and compact installations.
    if position(original in definition) = 0 then
        definition := replace(definition, 'coalesce(p.service_quantity, 1)', 'coalesce(p.package_sessions,p.service_quantity,1)');
    else
        definition := replace(definition, original, 'coalesce(p.package_sessions,p.service_quantity,1)');
    end if;
    if position(compiled in definition) = 0 then
        definition := replace(definition, 'coalesce(p.unit_price_at_sale, p.amount)', 'coalesce(p.package_unit_price,p.unit_price_at_sale,p.amount)');
    else
        definition := replace(definition, compiled, 'coalesce(p.package_unit_price,p.unit_price_at_sale,p.amount)');
    end if;
    if position('p.package_sessions' in definition) = 0 or position('p.package_unit_price' in definition) = 0 then
        raise exception 'Unexpected accounting_export definition';
    end if;
    execute definition;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
