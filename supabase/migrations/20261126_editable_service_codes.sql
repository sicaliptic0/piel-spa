begin;

alter table public.sale_services add column billing_code text;
update public.sale_services set billing_code = code;
alter table public.sale_services
    alter column billing_code set not null,
    alter column code set default ('S-' || upper(gen_random_uuid()::text)),
    add constraint sale_services_billing_code_unique unique (billing_code),
    add constraint sale_services_billing_code_format check (billing_code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$');

-- Older cached admin pages still send only the original identifier on insert.
create function public.set_service_billing_code()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
    new.billing_code := coalesce(new.billing_code, new.code);
    return new;
end;
$$;

create trigger sale_services_default_billing_code
before insert on public.sale_services
for each row execute function public.set_service_billing_code();

alter table public.payments add column service_code_snapshot text;

create function public.snapshot_service_billing_code()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
    if new.service_catalog_code is not null then
        select billing_code into new.service_code_snapshot
        from public.sale_services where code = new.service_catalog_code;
    else
        new.service_code_snapshot := null;
    end if;
    return new;
end;
$$;

create trigger payments_service_billing_code
before insert on public.payments
for each row execute function public.snapshot_service_billing_code();

do $migration$
declare
    definition text := pg_get_functiondef('public.accounting_export(text)'::regprocedure);
    original constant text := ', p.service_catalog_code ';
begin
    if (length(definition) - length(replace(definition, original, ''))) <> length(original) then
        raise exception 'Unexpected accounting_export definition';
    end if;
    execute replace(definition, original, ', coalesce(p.service_code_snapshot, p.service_catalog_code) ');
end;
$migration$;

notify pgrst, 'reload schema';
commit;
