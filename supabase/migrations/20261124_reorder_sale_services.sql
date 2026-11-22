create or replace function public.reorder_sale_services(p_codes text[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Acceso restringido' using errcode = '42501';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(114293, 23018);
    perform 1 from public.sale_services where active for update;

    if p_codes is null or cardinality(p_codes) <> (select count(*) from public.sale_services where active)
       or cardinality(p_codes) <> (select count(distinct code) from unnest(p_codes) as requested(code))
       or exists (select 1 from public.sale_services where active and not (code = any(p_codes))) then
        raise exception 'La lista de servicios cambió. Vuelve a cargarla e inténtalo de nuevo.';
    end if;

    update public.sale_services as service
    set sort_order = (requested.position - 1)::integer, updated_at = now()
    from unnest(p_codes) with ordinality as requested(code, position)
    where service.code = requested.code and service.active
      and service.sort_order <> (requested.position - 1)::integer;
end;
$$;

revoke all on function public.reorder_sale_services(text[]) from public, anon;
grant execute on function public.reorder_sale_services(text[]) to authenticated;
notify pgrst, 'reload schema';
