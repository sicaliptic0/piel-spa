-- WhatsApp assistant, phase 1 (menus, no AI) — 2026-11-23.
--
-- wa_settings: bot_test_phones = numbers the bot answers while bot_enabled is
--   still false (test mode); promo_text = the one promotion every greeting
--   mentions (empty = none); human_hours = when staff answers WhatsApp
--   (America/New_York), used for the "we reply when we open" message.
-- wa_conversations: what the bot is waiting for (bot_state), when it last
--   greeted, why it handed the chat to staff, and the Meta ad the chat came
--   from (click-to-WhatsApp referral).
-- sale_services: bot_visible = the bot may show this service and its price;
--   bot_description = one short line for WhatsApp. Nothing is visible until
--   staff marks it.

begin;

alter table public.wa_settings
    add column if not exists bot_test_phones text[] not null default '{}',
    add column if not exists promo_text text not null default '🖤 Black Friday: 15% de descuento en nuestros servicios en Piel Spa, Manhattan (frente a Penn Station).',
    add column if not exists human_hours jsonb not null default '{"days":[1,2,3,4,5,6],"open":"09:00","close":"19:00"}';

alter table public.wa_conversations
    add column if not exists bot_state text,
    add column if not exists bot_state_at timestamptz,
    add column if not exists bot_greeted_at timestamptz,
    add column if not exists handoff_reason text,
    add column if not exists handoff_at timestamptz,
    add column if not exists ad_referral jsonb,
    add column if not exists ad_headline text,
    add column if not exists ad_at timestamptz;

alter table public.sale_services
    add column if not exists bot_visible boolean not null default false,
    add column if not exists bot_description text;

-- Who answers an incoming message: the bot when it is on (or the number is in
-- the test list) and the chat is not with a person.
create or replace function public.wa_bot_handles(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(c.bot_active, false)
       and (coalesce(s.bot_enabled, false) or c.phone = any(coalesce(s.bot_test_phones, '{}')))
    from public.wa_conversations c
    cross join (select bot_enabled, bot_test_phones from public.wa_settings where id = 1) s
    where c.id = p_conversation_id;
$$;
revoke all on function public.wa_bot_handles(uuid) from public, anon, authenticated;

create or replace function public.wa_messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_preview text;
begin
    v_preview := coalesce(nullif(left(new.body, 120), ''),
        case new.media_type when 'image' then '📷 Foto' when 'document' then '📄 Documento'
             when 'audio' then '🎤 Audio' when 'video' then '🎥 Video' when 'sticker' then 'Sticker' else '' end);

    if new.direction = 'in' then
        update public.wa_conversations set
            unread_count = unread_count + 1,
            needs_attention = not coalesce(public.wa_bot_handles(new.conversation_id), false),
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

commit;
notify pgrst, 'reload schema';
