-- WhatsApp assistant: language and location — 2026-11-23.
-- wa_conversations.bot_lang ('es' | 'en') and bot_location ('piel_spa' |
-- 'divine_bliss'): asked to unknown numbers, read from history for patients.
-- Divine Bliss chats go straight to staff; only Piel Spa Manhattan gets the
-- promotion and the menu. English texts for the promotion and services.

begin;

alter table public.wa_conversations
    add column if not exists bot_lang text check (bot_lang in ('es', 'en')),
    add column if not exists bot_location text check (bot_location in ('piel_spa', 'divine_bliss'));

alter table public.wa_settings
    add column if not exists promo_text_en text not null
        default '🖤 Black Friday: 15% off our services at Piel Spa Manhattan (across from Penn Station).';

alter table public.sale_services
    add column if not exists bot_name_en text,
    add column if not exists bot_description_en text;

update public.sale_services as s set bot_name_en = v.name_en
from (values
    ('CONSULTA', 'Consultation only'),
    ('FAC-ESENCIAL', 'Essential Facial'),
    ('FAC-PIEL-GLOW', 'Piel Glow Facial'),
    ('FAC-GLASS-SKIN', 'Glass Skin Facial'),
    ('FAC-ACNE', 'Purifying Acne Facial'),
    ('PEEL-LUMINOSIDAD', 'Radiance Peel'),
    ('PEEL-DESPIG', 'Depigmenting Peel'),
    ('PEEL-MANDELICO', 'Firming Mandelic Peel'),
    ('PEEL-CLARIFICANTE', 'Clarifying Peel'),
    ('DRENAJE-FACIAL', 'Manual facial lymphatic drainage'),
    ('COSMELAN', 'Cosmelan® depigmenting protocol'),
    ('TOXINA-UNIDAD', 'Botulinum toxin · per unit'),
    ('RD-01', 'Lip filler (1 mL syringe)'),
    ('RD-02', 'Under-eye hyaluronic acid filler'),
    ('S-61F341EE-25E2-42BE-B75B-1122F521386D', 'Facial harmonization with hyaluronic acid'),
    ('BE-01', 'Radiesse'),
    ('BE-02', 'Sculptra (poly-L-lactic acid, 1 vial)'),
    ('S-B5FE8FEF-D679-453C-934D-467EAE14696F', 'Revok 50 biostimulation'),
    ('S-996F118D-732A-41C6-BC48-9971445A4CDC', 'Juvelook under-eye biostimulation'),
    ('ENDOLIFTING', 'Face endolift (endolaser)'),
    ('S-23889BC3-5A44-4257-B33D-AD0F0476730D', 'Face and neck endolift (endolaser)'),
    ('S-64F0D215-5355-4B27-AEF4-83A18E4C98BC', 'Arms endolift (endolaser)'),
    ('S-69090EBB-3590-4528-9092-D517535553FA', 'Abdomen and back endolift (endolaser)')
) as v(code, name_en)
where s.code = v.code and s.bot_name_en is null;

update public.sale_services set bot_description_en = 'Requires a prior medical assessment.'
where bot_description = 'Requiere valoración médica previa.' and bot_description_en is null;

commit;
notify pgrst, 'reload schema';
