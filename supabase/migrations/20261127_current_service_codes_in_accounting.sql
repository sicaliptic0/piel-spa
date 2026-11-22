begin;

do $migration$
declare
    definition text := pg_get_functiondef('public.accounting_export(text)'::regprocedure);
    code_expression constant text := 'coalesce(p.service_code_snapshot, p.service_catalog_code)';
    income_source constant text := 'from public.payments p) x)';
    service_description constant text := 'coalesce(p.service_desc, p.category)';
begin
    if (length(definition) - length(replace(definition, code_expression, ''))) <> length(code_expression)
        or (length(definition) - length(replace(definition, income_source, ''))) <> length(income_source) then
        raise exception 'Unexpected accounting_export definition';
    end if;

    definition := replace(definition, code_expression,
        'coalesce(svc.billing_code, p.service_code_snapshot, p.service_catalog_code)');
    definition := replace(definition, income_source,
        'from public.payments p left join public.sale_services svc on svc.code = p.service_catalog_code) x)');
    definition := replace(definition, service_description, $desc$
        coalesce(case when svc.billing_code is not null then
            replace(p.service_desc,
                ' (' || coalesce(p.service_code_snapshot, p.service_catalog_code) || ')',
                ' (' || svc.billing_code || ')')
            else p.service_desc end, p.category)$desc$);
    execute definition;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
