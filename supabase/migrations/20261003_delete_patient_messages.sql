-- Lets the admin delete sent recommendations (patient_messages) from the
-- clinical history — e.g. one logged as sent by WhatsApp that never went out.
-- Deleting also removes it from the patient's portal.
-- admin.html tries a direct delete first and falls back to this function when
-- the table's policies don't allow it. Admin only.

create or replace function public.admin_delete_patient_messages(p_ids text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'not allowed' using errcode = '42501';
    end if;
    delete from public.patient_messages where id::text = any(p_ids);
end;
$$;

revoke all on function public.admin_delete_patient_messages(text[]) from public, anon;
grant execute on function public.admin_delete_patient_messages(text[]) to authenticated;
