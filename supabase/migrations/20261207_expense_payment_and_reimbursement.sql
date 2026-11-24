alter table public.acct_expenses
    add column if not exists payment_method text,
    add column if not exists reimbursed_from text,
    add column if not exists reimbursement_funds text,
    add column if not exists reimbursed_amount numeric(10, 2);

alter table public.acct_expenses drop constraint if exists acct_expenses_reimb_status_check;
alter table public.acct_expenses add constraint acct_expenses_reimb_status_check
    check (reimb_status in ('Pendiente', 'Parcial', 'Reembolsado', 'Aportado como capital', 'No aplica (pagó la LLC)', 'Sin dato'));

alter table public.acct_expenses drop constraint if exists acct_expenses_partial_reimbursement_check;
alter table public.acct_expenses add constraint acct_expenses_partial_reimbursement_check
    check (case when reimb_status = 'Parcial' then
        reimbursed_amount is not null and reimbursed_amount > 0 and reimbursed_amount < amount and reimbursed_on is not null
    else reimbursed_amount is null end);

-- Keep the installed export's income and recurring-expense logic intact.
do $$
declare
    definition text := pg_get_functiondef('public.accounting_export(text)'::regprocedure);
    marker constant text := '''fecha_reembolso'', e.reimbursed_on,';
begin
    if position('e.reimbursed_from' in definition) > 0 then
        return;
    end if;
    if position(marker in definition) = 0 then
        raise exception 'Unexpected accounting_export expense fields';
    end if;
    execute replace(definition, marker, marker ||
        ' ''metodo_pago'', e.payment_method, ''reembolsado_desde'', e.reimbursed_from,' ||
        ' ''origen_fondos'', e.reimbursement_funds, ''monto_reembolsado'', e.reimbursed_amount,');
end;
$$;
