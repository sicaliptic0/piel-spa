-- WhatsApp inbox ("Mensajes" in admin.html) — 2026-10-05.
--
-- wa_conversations: one row per WhatsApp number (the patient is matched by
--   phone when possible). Keeps the summary the chat list needs.
-- wa_messages: every message in or out, including photos/documents/audio,
--   whose files live in the private "wa-media" storage bucket.
-- wa_settings: one row. bot_enabled stays false until the AI assistant
--   (Phase 4) is switched on — until then every chat is answered by staff.
-- Only admins can read or write any of it. Realtime is enabled so the admin
-- sees new messages instantly. The whatsapp-webhook / whatsapp-send edge
-- functions (service role) write here.

-- ---------- Settings ----------
create table if not exists public.wa_settings (
    id int primary key default 1 check (id = 1),
    bot_enabled boolean not null default false,
    auto_close_minutes int not null default 30,
    updated_at timestamptz not null default now()
);
insert into public.wa_settings (id) values (1) on conflict do nothing;

-- ---------- Conversations ----------
create table if not exists public.wa_conversations (
    id uuid primary key default gen_random_uuid(),
    phone text not null unique,               -- WhatsApp id: digits with country code, e.g. 19295550000
    profile_name text,                        -- the name the contact uses on WhatsApp
    patient_id uuid,                          -- profiles.id when the phone matches a patient
    bot_active boolean not null default true, -- Phase 4: the AI answers while true
    human_since timestamptz,                  -- when staff took the chat over
    human_by uuid,
    needs_attention boolean not null default false, -- patient waiting for a staff reply
    unread_count int not null default 0,
    last_message_at timestamptz,
    last_message_preview text,
    last_message_direction text,
    last_inbound_at timestamptz,              -- free-form replies are only allowed within 24 h of this
    last_activity_at timestamptz,             -- any message either way (30-min auto-close)
    created_at timestamptz not null default now()
);
create index if not exists wa_conversations_last_message_idx on public.wa_conversations (last_message_at desc);

-- ---------- Messages ----------
create table if not exists public.wa_messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.wa_conversations (id) on delete cascade,
    direction text not null check (direction in ('in', 'out')),
    sender text not null check (sender in ('patient', 'staff', 'bot', 'system')),
    staff_user_id uuid,
    body text,
    media_type text,       -- image | document | audio | video | sticker
    media_path text,       -- path in the wa-media bucket
    media_mime text,
    media_filename text,
    wa_message_id text unique,
    status text not null default 'sent', -- in: received · out: sent / delivered / read / failed
    error text,
    created_at timestamptz not null default now()
);
create index if not exists wa_messages_conversation_idx on public.wa_messages (conversation_id, created_at);

-- Keep the conversation summary in step with each new message.
create or replace function public.wa_messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_bot_enabled boolean;
    v_preview text;
begin
    select bot_enabled into v_bot_enabled from public.wa_settings where id = 1;
    v_preview := coalesce(nullif(left(new.body, 120), ''),
        case new.media_type when 'image' then '📷 Foto' when 'document' then '📄 Documento'
             when 'audio' then '🎤 Audio' when 'video' then '🎥 Video' when 'sticker' then 'Sticker' else '' end);

    if new.direction = 'in' then
        update public.wa_conversations set
            unread_count = unread_count + 1,
            needs_attention = not (coalesce(v_bot_enabled, false) and bot_active),
            last_message_at = new.created_at,
            last_message_preview = v_preview,
            last_message_direction = 'in',
            last_inbound_at = new.created_at,
            last_activity_at = new.created_at
        where id = new.conversation_id;
    else
        update public.wa_conversations set
            needs_attention = case when new.sender = 'staff' then false else needs_attention end,
            unread_count = case when new.sender = 'staff' then 0 else unread_count end,
            last_message_at = new.created_at,
            last_message_preview = v_preview,
            last_message_direction = 'out',
            last_activity_at = new.created_at
        where id = new.conversation_id;
    end if;
    return new;
end;
$$;

drop trigger if exists wa_messages_after_insert on public.wa_messages;
create trigger wa_messages_after_insert
    after insert on public.wa_messages
    for each row execute function public.wa_messages_after_insert();

-- ---------- Access: admins only ----------
alter table public.wa_settings enable row level security;
alter table public.wa_conversations enable row level security;
alter table public.wa_messages enable row level security;

drop policy if exists "admin_all_wa_settings" on public.wa_settings;
create policy "admin_all_wa_settings" on public.wa_settings
    for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin_all_wa_conversations" on public.wa_conversations;
create policy "admin_all_wa_conversations" on public.wa_conversations
    for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin_all_wa_messages" on public.wa_messages;
create policy "admin_all_wa_messages" on public.wa_messages
    for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Realtime ----------
do $$
begin
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'wa_conversations') then
        alter publication supabase_realtime add table public.wa_conversations;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'wa_messages') then
        alter publication supabase_realtime add table public.wa_messages;
    end if;
end;
$$;

-- ---------- Photos / files (private bucket) ----------
insert into storage.buckets (id, name, public)
values ('wa-media', 'wa-media', false)
on conflict (id) do nothing;

drop policy if exists "admin_read_wa_media" on storage.objects;
create policy "admin_read_wa_media" on storage.objects
    for select to authenticated using (bucket_id = 'wa-media' and public.is_admin());
drop policy if exists "admin_upload_wa_media" on storage.objects;
create policy "admin_upload_wa_media" on storage.objects
    for insert to authenticated with check (bucket_id = 'wa-media' and public.is_admin());
