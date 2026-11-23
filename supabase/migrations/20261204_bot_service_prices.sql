-- WhatsApp assistant prices — 2026-11-23.
-- bot_price_mode: exact = shows the price · from = "desde $X" · consult = no
-- price ("precio según tu consulta"). Visible services chosen with the clinic:
-- facials, peelings, consultation, toxin and fillers, biostimulators,
-- endolifting and Cosmelan. Regeneratives (NCTF, PDRN, Profhilo, skinboosters,
-- Mesoheal, Modelha) stay hidden until the health lawyer approves them.

begin;

alter table public.sale_services
    add column if not exists bot_price_mode text not null default 'exact'
        check (bot_price_mode in ('exact', 'from', 'consult'));

update public.sale_services set bot_visible = true, bot_price_mode = 'exact', updated_at = now()
where code in ('CONSULTA', 'FAC-ESENCIAL', 'FAC-PIEL-GLOW', 'FAC-GLASS-SKIN', 'FAC-ACNE', 'PEEL-LUMINOSIDAD',
               'PEEL-DESPIG', 'PEEL-MANDELICO', 'PEEL-CLARIFICANTE', 'DRENAJE-FACIAL',
               'TOXINA-UNIDAD', 'RD-01', 'RD-02', 'COSMELAN');

-- Biostimulators and endolifting: "desde".
update public.sale_services set bot_visible = true, bot_price_mode = 'from', updated_at = now()
where code in ('BE-01', 'BE-02', 'S-B5FE8FEF-D679-453C-934D-467EAE14696F', 'S-996F118D-732A-41C6-BC48-9971445A4CDC',
               'ENDOLIFTING', 'S-23889BC3-5A44-4257-B33D-AD0F0476730D', 'S-64F0D215-5355-4B27-AEF4-83A18E4C98BC',
               'S-69090EBB-3590-4528-9092-D517535553FA');

-- Facial harmonization: price after the consultation.
update public.sale_services set bot_visible = true, bot_price_mode = 'consult', updated_at = now()
where code = 'S-61F341EE-25E2-42BE-B75B-1122F521386D';

-- Medical treatments: say so (only where staff hasn't written a description).
update public.sale_services set bot_description = 'Requiere valoración médica previa.'
where bot_visible and bot_description is null
  and code in ('TOXINA-UNIDAD', 'RD-01', 'RD-02', 'COSMELAN', 'BE-01', 'BE-02', 'S-B5FE8FEF-D679-453C-934D-467EAE14696F',
               'S-996F118D-732A-41C6-BC48-9971445A4CDC', 'ENDOLIFTING', 'S-23889BC3-5A44-4257-B33D-AD0F0476730D',
               'S-64F0D215-5355-4B27-AEF4-83A18E4C98BC', 'S-69090EBB-3590-4528-9092-D517535553FA',
               'S-61F341EE-25E2-42BE-B75B-1122F521386D');

commit;
notify pgrst, 'reload schema';
