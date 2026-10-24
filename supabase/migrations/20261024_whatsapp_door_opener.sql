-- WhatsApp "door opener" — 2026-10-24.
--
-- When a chat's 24 h window is closed, staff can still write: the text waits
-- here while an approved template (e.g. mensaje_tratamiento "…tiene información
-- sobre tu tratamiento. ¿Te la enviamos por aquí?") goes out. As soon as the
-- patient answers anything (or taps "Sí, envíenmela") the window is open again
-- and whatsapp-webhook delivers the waiting text. Admin only.

create table if not exists public.wa_pending_messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.wa_conversations (id) on delete cascade,
    body text not null,
    created_by uuid,
    opener_message_id uuid,                      -- wa_messages.id of the template that went out
    status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'discarded', 'expired')),
    sent_at timestamptz,
    error text,
    created_at timestamptz not null default now()
);
create index if not exists wa_pending_messages_conv_idx on public.wa_pending_messages (conversation_id) where status = 'pending';
alter table public.wa_pending_messages enable row level security;

drop policy if exists "admin_all_wa_pending_messages" on public.wa_pending_messages;
create policy "admin_all_wa_pending_messages" on public.wa_pending_messages
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- Live in the admin (the banner disappears when the text is delivered).
do $$
begin
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'wa_pending_messages') then
        alter publication supabase_realtime add table public.wa_pending_messages;
    end if;
end $$;
