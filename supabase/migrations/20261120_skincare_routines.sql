-- Skincare routines: product catalog (tagged for the rules engine in admin.html)
-- and the routines given to each patient (with a snapshot of the chosen products,
-- so later catalog edits never change what a patient was told).
-- Re-runnable: the catalog seed upserts by id.

create table if not exists public.skincare_products (
    id              text primary key,
    name            text not null,
    brand           text not null,
    -- cleanser | double_cleanse | serum | active_am | active_pm | moisturizer | repair | eye | spf | weekly
    step            text not null,
    -- normal | combination | oily | dry | sensitive (same ids as the intake's skin_type)
    skin_types      text[] not null default '{}',
    -- wrinkles | spots | melasma | acne | shine | redness | dehydration | texture
    -- eye_pigment | eye_vascular | eye_wrinkles
    concerns        text[] not null default '{}',
    -- retinoid | tretinoin | aha | bha | bpo | azelaic | vitc | niacinamide | tranexamic
    -- tyrosinase | hydroquinone | peptide | bakuchiol | ha | barrier | mineral
    classes         text[] not null default '{}',
    time_of_day     text not null default 'both',      -- am | pm | both
    in_stock        boolean not null default false,    -- sold at Piel Spa
    is_prescription boolean not null default false,
    pregnancy       text not null default 'safe',      -- safe | consult | avoid
    irritation      int not null default 0,            -- 0 none … 3 high
    tinted          boolean not null default false,    -- SPF with iron oxides
    usage           text,                              -- instruction printed in the guide
    active          boolean not null default true,     -- false = not available in our market
    created_at      timestamptz not null default now()
);

create table if not exists public.skincare_routines (
    id          uuid primary key default gen_random_uuid(),
    patient_id  uuid not null references public.profiles (id) on delete cascade,
    level       text not null,                 -- basic | advanced
    skin_type   text,
    sensitive   boolean not null default false,
    concerns    text[] not null default '{}',
    safety      jsonb not null default '{}',   -- pregnancy, isotretinoin, recent procedure…
    items       jsonb not null default '[]',   -- [{slot, rank, product snapshot…}]
    guide_title text,
    guide_text  text,
    message_id  uuid,                          -- patient_messages row, if sent to the portal
    created_by  uuid default auth.uid(),
    created_at  timestamptz not null default now()
);
create index if not exists skincare_routines_patient_idx on public.skincare_routines (patient_id, created_at desc);

alter table public.skincare_products enable row level security;
alter table public.skincare_routines enable row level security;

drop policy if exists "admin_all_skincare_products" on public.skincare_products;
create policy "admin_all_skincare_products" on public.skincare_products
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

drop policy if exists "admin_all_skincare_routines" on public.skincare_routines;
create policy "admin_all_skincare_routines" on public.skincare_routines
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- The patient sees their own routines in the portal (dashboard.html), read only.
drop policy if exists "patient_reads_own_skincare_routines" on public.skincare_routines;
create policy "patient_reads_own_skincare_routines" on public.skincare_routines
    for select to authenticated
    using (patient_id = auth.uid());

-- ---------- Catalog seed ----------
insert into public.skincare_products
    (id, name, brand, step, skin_types, concerns, classes, time_of_day, in_stock, is_prescription, pregnancy, irritation, tinted, usage)
values
-- Limpiadores
('meso_purifying_mousse','Purifying Mousse','mesoestetic','cleanser','{combination,oily}','{acne,shine}','{bha}','both',true,false,'safe',1,false,'Masajear sobre la piel húmeda 30 segundos y enjuagar.'),
('lrp_effaclar_gel','Effaclar Gel Limpiador Purificante','La Roche-Posay','cleanser','{combination,oily}','{acne,shine}','{}','both',false,false,'safe',0,false,null),
('lrp_effaclar_medicated','Effaclar Gel Limpiador Medicado (salicílico 2%)','La Roche-Posay','cleanser','{oily}','{acne,shine}','{bha}','both',false,false,'consult',1,false,null),
('lrp_toleriane_hydrating','Toleriane Hydrating Gentle Cleanser','La Roche-Posay','cleanser','{normal,dry,sensitive}','{melasma,redness,dehydration}','{}','both',false,false,'safe',0,false,null),
('lrp_toleriane_caring','Toleriane Caring Wash','La Roche-Posay','cleanser','{normal,combination,sensitive}','{redness}','{}','both',false,false,'safe',0,false,null),
('eucerin_dermopure_gel','DermoPurifyer Oil Control Gel Limpiador','Eucerin','cleanser','{combination,oily}','{acne,shine}','{}','both',false,false,'safe',0,false,null),
('eucerin_hyaluron_gel','Hyaluron Gel Limpiador','Eucerin','cleanser','{normal,combination,dry}','{dehydration}','{}','both',false,false,'safe',0,false,null),
('isdin_acniben_gel','Acniben Gel Limpiador','ISDIN','cleanser','{oily}','{acne,shine}','{}','both',false,false,'safe',0,false,null),
('cerave_hydrating','Hydrating Facial Cleanser','CeraVe','cleanser','{normal,dry,sensitive}','{dehydration}','{barrier}','both',false,false,'safe',0,false,null),
('cerave_foaming','Foaming Facial Cleanser','CeraVe','cleanser','{normal,combination,oily}','{shine}','{}','both',false,false,'safe',0,false,null),
('cerave_acne_bpo','Acne Foaming Cream Cleanser (peróxido de benzoilo 4%)','CeraVe','cleanser','{oily}','{acne}','{bpo}','am',false,false,'consult',1,false,'Solo en la mañana. Mancha la ropa y toallas.'),
('avene_tolerance_cleanser','Tolérance Extremely Gentle Cleanser','Avène','cleanser','{dry,sensitive}','{redness}','{}','both',false,false,'safe',0,false,null),
('cerave_cream_to_foam','Hydrating Cream-to-Foam Cleanser','CeraVe','cleanser','{normal,dry}','{dehydration}','{barrier}','both',false,false,'safe',0,false,null),
('bioderma_sensibio_gel','Sensibio Gel Moussant','Bioderma','cleanser','{normal,combination,sensitive}','{redness}','{}','both',false,false,'safe',0,false,null),
('vanicream_gentle','Gentle Facial Cleanser','Vanicream','cleanser','{normal,dry,sensitive}','{redness}','{}','both',false,false,'safe',0,false,null),
('bioderma_sebium_gel','Sébium Gel Moussant','Bioderma','cleanser','{combination,oily}','{acne,shine}','{}','both',false,false,'safe',0,false,null),
-- Doble limpieza (primer paso de la noche, rutina avanzada)
('isdin_essential_oil','Essential Cleansing (aceite limpiador)','ISDIN','double_cleanse','{normal,combination,dry}','{}','{}','pm',false,false,'safe',0,false,'Sobre la piel seca, masajear para disolver protector y maquillaje; emulsionar con agua y enjuagar.'),
('lrp_micellar_ultra','Agua Micelar Ultra','La Roche-Posay','double_cleanse','{normal,combination,dry,sensitive}','{}','{}','pm',false,false,'safe',0,false,'Con un algodón, sin frotar, para retirar protector y maquillaje.'),
('lrp_effaclar_micellar','Effaclar Agua Micelar','La Roche-Posay','double_cleanse','{combination,oily}','{acne,shine}','{}','pm',false,false,'safe',0,false,'Con un algodón, sin frotar, para retirar protector y maquillaje.'),
('bioderma_sensibio_h2o','Sensibio H2O (agua micelar)','Bioderma','double_cleanse','{normal,dry,sensitive,combination}','{redness}','{}','pm',false,false,'safe',0,false,'Con un algodón, sin frotar, para retirar protector y maquillaje.'),
('eucerin_micellar','DermatoClean Hyaluron Agua Micelar','Eucerin','double_cleanse','{normal,combination,oily,dry,sensitive}','{}','{}','pm',false,false,'safe',0,false,'Con un algodón, sin frotar, para retirar protector y maquillaje.'),
-- Sérum hidratante / barrera
('meso_ha_densimatrix','HA Densimatrix','mesoestetic','serum','{normal,combination,oily,dry,sensitive}','{wrinkles,dehydration,eye_wrinkles}','{ha}','both',true,false,'safe',0,false,null),
('cs_barrier_pro','Barrier Pro Serum Spray','Colorescience','serum','{normal,combination,oily,sensitive}','{dehydration,redness}','{barrier}','am',true,false,'safe',0,false,'3 a 5 pulverizaciones con los ojos cerrados; se puede repetir sobre el protector durante el día.'),
('lrp_hyalu_b5','Hyalu B5 Serum','La Roche-Posay','serum','{normal,combination,dry,sensitive}','{wrinkles,dehydration}','{ha}','both',false,false,'safe',0,false,null),
('eucerin_hf_serum','Hyaluron-Filler Serum','Eucerin','serum','{normal,combination,dry}','{wrinkles,dehydration}','{ha}','both',false,false,'safe',0,false,null),
('isdin_ha_concentrate','Hyaluronic Concentrate','ISDIN','serum','{normal,combination,oily,dry}','{wrinkles,dehydration}','{ha}','both',false,false,'safe',0,false,null),
('cerave_ha_serum','Hydrating Hyaluronic Acid Serum','CeraVe','serum','{normal,combination,oily,dry,sensitive}','{dehydration}','{ha,barrier}','both',false,false,'safe',0,false,null),
('avene_hydrance_boost','Hydrance Boost Sérum','Avène','serum','{dry,sensitive}','{dehydration}','{ha}','both',false,false,'safe',0,false,null),
('lrp_dermallergo_serum','Toleriane Dermallergo Serum','La Roche-Posay','serum','{normal,dry,sensitive}','{redness,dehydration}','{barrier}','both',false,false,'safe',0,false,null),
('lrp_rosaliac_ar','Rosaliac AR Intense','La Roche-Posay','serum','{normal,combination,dry,sensitive}','{redness}','{}','both',false,false,'safe',0,false,null),
-- Activo de mañana
('meso_tran3x_concentrate','Melan Tran3x Concentrate','mesoestetic','active_am','{normal,combination,oily,dry,sensitive}','{melasma,spots}','{tranexamic,tyrosinase}','both',true,false,'consult',0,false,null),
('lrp_mela_b3','Mela B3 Serum','La Roche-Posay','active_am','{normal,combination,oily,dry,sensitive}','{melasma,spots}','{niacinamide,tyrosinase}','am',false,false,'consult',1,false,null),
('eucerin_antipigment_serum','Anti-Pigment Dual Serum (tiamidol)','Eucerin','active_am','{normal,combination,oily,dry,sensitive}','{melasma,spots}','{tyrosinase}','am',false,false,'consult',0,false,null),
('isdin_melaclear','Isdinceutics Melaclear Advanced','ISDIN','active_am','{normal,combination,oily,dry}','{melasma,spots}','{tyrosinase,tranexamic}','am',false,false,'consult',1,false,null),
('sc_phloretin_cf','Phloretin CF','SkinCeuticals','active_am','{normal,combination,oily}','{spots,wrinkles,melasma}','{vitc}','am',false,false,'safe',1,false,null),
('sc_ce_ferulic','C E Ferulic','SkinCeuticals','active_am','{normal,combination,dry}','{wrinkles,spots,texture}','{vitc}','am',false,false,'safe',1,false,null),
('lrp_vitc10','Pure Vitamin C10','La Roche-Posay','active_am','{normal,combination,oily,dry}','{wrinkles,spots,texture}','{vitc}','am',false,false,'safe',1,false,null),
('isdin_flavoc','Flavo-C Sérum','ISDIN','active_am','{normal,combination,oily,dry}','{wrinkles,spots}','{vitc}','am',false,false,'safe',0,false,null),
('eucerin_hf_vitc','Hyaluron-Filler Vitamin C Booster','Eucerin','active_am','{normal,combination,dry}','{wrinkles,spots}','{vitc}','am',false,false,'safe',0,false,null),
('lrp_niacinamide10','Pure Niacinamide 10 Serum','La Roche-Posay','active_am','{normal,combination,oily}','{shine,spots,acne}','{niacinamide}','both',false,false,'safe',0,false,null),
('pc_niacinamide','10% Niacinamide Booster','Paula''s Choice','active_am','{normal,combination,oily}','{shine,acne,spots}','{niacinamide}','both',false,false,'safe',0,false,null),
('to_niacinamide','Niacinamide 10% + Zinc 1%','The Ordinary','active_am','{combination,oily}','{shine,acne}','{niacinamide}','both',false,false,'safe',0,false,null),
-- Activo de noche
('tretinoin_0025','Tretinoína 0.025% crema','Receta médica','active_pm','{normal,combination,oily,dry}','{wrinkles,melasma,acne,spots,texture}','{retinoid,tretinoin}','pm',false,true,'avoid',3,false,'Una cantidad del tamaño de un guisante para todo el rostro, sobre la piel bien seca, evitando ojos, comisuras y aletas nasales.'),
('meso_skinretin','Skinretin 0.3% (retinol + bakuchiol)','mesoestetic','active_pm','{normal,combination,oily,dry}','{wrinkles,texture,spots}','{retinoid,bakuchiol}','pm',true,false,'avoid',2,false,'Primeras 2 semanas en noches alternas; luego diario si hay buena tolerancia.'),
('meso_blemiderm','Blemiderm Treatment','mesoestetic','active_pm','{combination,oily}','{acne,shine,texture}','{retinoid,bha,aha,azelaic}','pm',true,false,'avoid',2,false,'Solo de noche, capa fina en todo el rostro o en las zonas con granitos.'),
('meso_tran3x_gelcream','Melan Tran3x Gel Cream','mesoestetic','active_pm','{normal,combination,oily,dry,sensitive}','{melasma,spots}','{tranexamic,tyrosinase}','pm',true,false,'consult',0,false,null),
('lrp_retinol_b3','Retinol B3 Serum','La Roche-Posay','active_pm','{normal,combination,oily,dry}','{wrinkles,texture}','{retinoid}','pm',false,false,'avoid',2,false,'Empezar 2 a 3 noches por semana.'),
('avene_retrinal','RetrinAL 0.1 Crema Intensiva','Avène','active_pm','{normal,combination,dry}','{wrinkles,spots}','{retinoid}','pm',false,false,'avoid',2,false,'Empezar 2 a 3 noches por semana.'),
('sc_retinol03','Retinol 0.3','SkinCeuticals','active_pm','{normal,combination,oily}','{wrinkles,texture}','{retinoid}','pm',false,false,'avoid',2,false,'Empezar 2 a 3 noches por semana.'),
('differin_adapalene','Adapaleno 0.1% gel (Differin)','Galderma','active_pm','{normal,combination,oily}','{acne,texture}','{retinoid}','pm',false,false,'avoid',2,false,'Capa fina en todo el rostro, no solo en los granitos. Empezar en noches alternas.'),
('inkey_bakuchiol','Bakuchiol Moisturizer','The Inkey List','active_pm','{normal,combination,dry,sensitive}','{wrinkles}','{bakuchiol}','pm',false,false,'consult',0,false,null),
('sc_discoloration','Discoloration Defense','SkinCeuticals','active_pm','{normal,combination,oily,dry,sensitive}','{melasma,spots}','{tranexamic,niacinamide,tyrosinase}','both',false,false,'consult',1,false,null),
('eucerin_antipigment_night','Anti-Pigment Crema de Noche','Eucerin','active_pm','{normal,combination,dry}','{melasma,spots}','{tyrosinase}','pm',false,false,'consult',0,false,null),
('azelaic_rx','Ácido azelaico 15% gel (Finacea)','Receta médica','active_pm','{normal,combination,oily,dry,sensitive}','{melasma,spots,redness,acne}','{azelaic}','both',false,true,'safe',1,false,null),
('pc_azelaic','10% Azelaic Acid Booster','Paula''s Choice','active_pm','{normal,combination,oily,dry,sensitive}','{melasma,spots,redness,acne,texture}','{azelaic}','both',false,false,'safe',1,false,null),
('hydroquinone_4','Hidroquinona 4% (receta, ciclos de máximo 3 meses)','Receta médica','active_pm','{normal,combination,oily,dry}','{melasma,spots}','{hydroquinone}','pm',false,true,'avoid',2,false,'Solo sobre las manchas, en ciclos de máximo 3 meses con descanso, según indicación médica.'),
('pc_bha','Skin Perfecting 2% BHA Liquid','Paula''s Choice','active_pm','{normal,combination,oily}','{acne,shine,texture}','{bha}','pm',false,false,'consult',2,false,null),
('eucerin_dermopure_serum','DermoPurifyer Serum Renovador','Eucerin','active_pm','{combination,oily}','{acne,shine,texture}','{aha,bha}','pm',false,false,'consult',1,false,null),
('lrp_effaclar_serum','Effaclar Serum Ultra Concentrado','La Roche-Posay','active_pm','{combination,oily}','{acne,shine,texture}','{aha,bha}','pm',false,false,'consult',2,false,null),
('isdin_night_peel','Isdinceutics Night Peel','ISDIN','active_pm','{normal,combination,oily}','{texture,spots,wrinkles}','{aha}','pm',false,false,'consult',2,false,null),
('to_mandelic','Mandelic Acid 10% + HA','The Ordinary','active_pm','{normal,combination,oily}','{texture,acne,spots}','{aha}','pm',false,false,'consult',1,false,null),
-- Hidratante
('meso_hydravital_light','Hydra-Vital Light','mesoestetic','moisturizer','{normal,combination,oily}','{dehydration,shine}','{}','both',true,false,'safe',0,false,null),
('meso_hydracream_fusion','Hydracream Fusion','mesoestetic','moisturizer','{normal,dry}','{dehydration}','{}','both',true,false,'safe',0,false,null),
('meso_brightening_cream','Age Element Brightening Cream','mesoestetic','moisturizer','{normal,combination}','{spots,wrinkles}','{tyrosinase}','both',true,false,'consult',0,false,null),
('meso_couperend','Couperend Maintenance Cream','mesoestetic','moisturizer','{normal,dry,sensitive}','{redness}','{}','both',true,false,'safe',0,false,null),
('lrp_double_repair','Toleriane Double Repair Moisturizer','La Roche-Posay','moisturizer','{normal,combination,dry,sensitive}','{dehydration}','{barrier,niacinamide}','both',false,false,'safe',0,false,null),
('lrp_duo_m','Effaclar Duo+M','La Roche-Posay','moisturizer','{combination,oily}','{acne,shine}','{niacinamide}','both',false,false,'safe',1,false,null),
('lrp_toleriane_sensitive','Toleriane Sensitive','La Roche-Posay','moisturizer','{dry,sensitive}','{redness}','{barrier}','both',false,false,'safe',0,false,null),
('eucerin_dermopure_fluid','DermoPurifyer Oil Control Fluido Hidratante','Eucerin','moisturizer','{combination,oily}','{shine,acne}','{}','both',false,false,'safe',0,false,null),
('eucerin_hf_cream','Hyaluron-Filler Día / Noche','Eucerin','moisturizer','{normal,dry}','{wrinkles,dehydration}','{ha}','both',false,false,'safe',0,false,null),
('eucerin_urea_face','UreaRepair Crema Facial 5% Urea','Eucerin','moisturizer','{dry}','{dehydration}','{barrier}','both',false,false,'safe',0,false,null),
('isdin_hyaluronic_moisture','Isdinceutics Hyaluronic Moisture (piel grasa)','ISDIN','moisturizer','{combination,oily}','{shine,dehydration}','{ha}','both',false,false,'safe',0,false,null),
('cerave_pm_lotion','PM Facial Moisturizing Lotion','CeraVe','moisturizer','{normal,combination,oily,sensitive}','{dehydration}','{barrier,niacinamide}','both',false,false,'safe',0,false,null),
('cerave_cream','Moisturizing Cream','CeraVe','moisturizer','{dry,sensitive}','{dehydration}','{barrier}','both',false,false,'safe',0,false,null),
('avene_tolerance_control','Tolérance Control Crema Calmante','Avène','moisturizer','{normal,dry,sensitive}','{redness}','{barrier}','both',false,false,'safe',0,false,null),
('bioderma_sebium_hydra','Sébium Hydra','Bioderma','moisturizer','{oily}','{acne}','{}','both',false,false,'safe',0,false,null),
-- Reparador / barrera (paso condicional)
('meso_melan_recovery','Melan Recovery','mesoestetic','repair','{normal,combination,oily,dry,sensitive}','{melasma,redness}','{barrier}','both',false,false,'safe',0,false,null),
('lrp_cicaplast_b5','Cicaplast Baume B5+','La Roche-Posay','repair','{normal,combination,dry,sensitive}','{redness}','{barrier}','both',false,false,'safe',0,false,null),
('avene_cicalfate','Cicalfate+ Crema Reparadora','Avène','repair','{normal,combination,dry,sensitive}','{redness}','{barrier}','both',false,false,'safe',0,false,null),
('bioderma_cicabio','Cicabio Crème','Bioderma','repair','{normal,combination,dry,sensitive}','{redness}','{barrier}','both',false,false,'safe',0,false,null),
('eucerin_aquaphor','Aquaphor Pomada Reparadora','Eucerin','repair','{normal,combination,dry,sensitive}','{}','{barrier}','pm',false,false,'safe',0,false,'Solo en zonas puntuales muy secas o irritadas y en labios.'),
('cerave_healing','Healing Ointment','CeraVe','repair','{normal,dry,sensitive}','{}','{barrier}','pm',false,false,'safe',0,false,'Solo en zonas puntuales muy secas o irritadas y en labios.'),
-- Contorno de ojos
('meso_brightening_eye','Age Element Brightening Eye Contour','mesoestetic','eye','{normal,combination,oily,dry,sensitive}','{eye_pigment}','{tyrosinase}','both',true,false,'consult',0,false,null),
('meso_antiwrinkle_eye','Age Element Anti-Wrinkle Eye Contour','mesoestetic','eye','{normal,combination,oily,dry,sensitive}','{eye_wrinkles}','{peptide,bakuchiol}','both',true,false,'avoid',0,false,null),
('eucerin_antipigment_eye','Anti-Pigment Contorno de Ojos (tiamidol)','Eucerin','eye','{normal,combination,oily,dry,sensitive}','{eye_pigment}','{tyrosinase}','both',false,false,'consult',0,false,null),
('lrp_pigmentclar_eyes','Pigmentclar Eyes','La Roche-Posay','eye','{normal,combination,oily,dry,sensitive}','{eye_pigment,eye_vascular}','{}','am',false,false,'safe',0,false,null),
('isdin_kox_eyes','K-Ox Eyes','ISDIN','eye','{normal,combination,oily,dry,sensitive}','{eye_vascular,eye_pigment}','{}','both',false,false,'safe',0,false,null),
('eucerin_hf_eye','Hyaluron-Filler Contorno de Ojos','Eucerin','eye','{normal,combination,oily,dry,sensitive}','{eye_wrinkles}','{ha}','both',false,false,'safe',0,false,null),
('sc_age_eye','A.G.E. Eye Complex','SkinCeuticals','eye','{normal,combination,oily,dry}','{eye_wrinkles}','{peptide}','both',false,false,'safe',0,false,null),
('lrp_redermic_r_eyes','Redermic R Eyes (retinol)','La Roche-Posay','eye','{normal,combination,oily,dry}','{eye_wrinkles}','{retinoid}','pm',false,false,'avoid',1,false,null),
('cerave_eye_repair','Eye Repair Cream','CeraVe','eye','{normal,combination,oily,dry,sensitive}','{}','{barrier}','both',false,false,'safe',0,false,null),
-- Protector solar (Colorescience primero)
('cs_tinted','Sunforgettable Total Protection Face Shield SPF 50 (con color)','Colorescience','spf','{normal,combination,oily,dry,sensitive}','{melasma,spots,eye_pigment}','{mineral}','am',true,false,'safe',0,true,'Último paso de la mañana, también sobre el contorno. Reaplicar cada 2 a 3 horas si hay exposición.'),
('cs_untinted','Protector solar sin color','Colorescience','spf','{normal,combination,oily,dry,sensitive}','{}','{mineral}','am',true,false,'safe',0,false,'Último paso de la mañana. Reaplicar cada 2 a 3 horas si hay exposición.'),
('cs_brush_on','Total Protection Brush-On Shield SPF 50 (para reaplicar)','Colorescience','spf','{normal,combination,oily,dry,sensitive}','{melasma,spots,shine}','{mineral}','am',false,false,'safe',0,true,'Para reaplicar sobre el maquillaje durante el día.'),
('meso_melan130','Mesoprotech Melan 130+ Pigment Control','mesoestetic','spf','{normal,combination,dry}','{melasma,spots,eye_pigment}','{}','am',true,false,'safe',0,true,'Último paso de la mañana. Reaplicar cada 2 a 3 horas si hay exposición.'),
('meso_mineral_fluid','Mesoprotech Mineral Fluid','mesoestetic','spf','{normal,combination,oily,sensitive}','{redness}','{mineral}','am',true,false,'safe',0,false,'Último paso de la mañana. Reaplicar cada 2 a 3 horas si hay exposición.'),
('isdin_fusion_color','Fusion Water Color SPF 50','ISDIN','spf','{normal,combination,oily,sensitive}','{melasma,spots}','{}','am',false,false,'safe',0,true,null),
('heliocare_360_color','Heliocare 360 Color Gel Oil-Free','Heliocare','spf','{combination,oily}','{melasma,spots,shine}','{}','am',false,false,'safe',0,true,null),
('lrp_anthelios_mineral_tinted','Anthelios Mineral Tinted SPF 50','La Roche-Posay','spf','{normal,dry,sensitive}','{melasma,spots,redness}','{mineral}','am',false,false,'safe',0,true,null),
('eucerin_sun_pigment','Sun Pigment Control Tinted SPF 50+','Eucerin','spf','{normal,combination,dry}','{melasma,spots}','{}','am',false,false,'safe',0,true,null),
('eltamd_uv_clear','UV Clear SPF 46','EltaMD','spf','{combination,oily,sensitive}','{acne,redness}','{niacinamide}','am',false,false,'safe',0,false,null),
-- Semanal
('meso_pure_renewing_mask','Pure Renewing Mask','mesoestetic','weekly','{combination,oily}','{acne,shine,texture}','{bha,aha}','pm',true,false,'consult',2,false,'1 a 2 veces por semana: capa fina, dejar actuar el tiempo que indica el envase y enjuagar.'),
('meso_hydravital_mask','Hydra-Vital Mask','mesoestetic','weekly','{normal,combination,dry,sensitive}','{dehydration}','{ha}','pm',false,false,'safe',0,false,'1 a 2 veces por semana, en una noche sin activos.'),
('meso_antistress_mask','Anti-Stress Mask','mesoestetic','weekly','{normal,dry,sensitive}','{redness,dehydration}','{barrier}','pm',false,false,'safe',0,false,'1 a 2 veces por semana, en una noche sin activos.'),
('avene_hydrance_mask','Hydrance Mascarilla Rehidratante','Avène','weekly','{normal,dry,sensitive}','{dehydration}','{ha}','pm',false,false,'safe',0,false,'1 a 2 veces por semana, en una noche sin activos.')
on conflict (id) do update set
    name = excluded.name, brand = excluded.brand, step = excluded.step,
    skin_types = excluded.skin_types, concerns = excluded.concerns, classes = excluded.classes,
    time_of_day = excluded.time_of_day, in_stock = excluded.in_stock,
    is_prescription = excluded.is_prescription, pregnancy = excluded.pregnancy,
    irritation = excluded.irritation, tinted = excluded.tinted, usage = excluded.usage;

-- ---------- v2 (2026-11-20): published flag, PDF, WhatsApp documents ----------
-- The portal shows a routine only when staff chose "Publicar en el portal".
alter table public.skincare_routines add column if not exists published boolean not null default false;
alter table public.skincare_routines add column if not exists pdf_path text;   -- wa-media path of the guide PDF
update public.skincare_routines set published = true where message_id is not null and not published;

drop policy if exists "patient_reads_own_skincare_routines" on public.skincare_routines;
create policy "patient_reads_own_skincare_routines" on public.skincare_routines
    for select to authenticated
    using (patient_id = auth.uid() and published);

-- A text waiting behind the door-opener template can carry a document (the guide PDF).
alter table public.wa_pending_messages add column if not exists media_path text;
alter table public.wa_pending_messages add column if not exists media_type text;
alter table public.wa_pending_messages add column if not exists media_filename text;


-- ---------- v3 (2026-11-20): product details for the admin, US availability, photos ----------
alter table public.skincare_products add column if not exists format text;           -- gel, espuma, crema, aceite, micelar, sérum, fluido…
alter table public.skincare_products add column if not exists key_actives text;      -- "Retinol 0.3% + bakuchiol"
alter table public.skincare_products add column if not exists shades text[] not null default '{}';
alter table public.skincare_products add column if not exists internal_notes text;   -- staff only, never in the guide
alter table public.skincare_products add column if not exists us_available boolean not null default true;
alter table public.skincare_products add column if not exists image_url text;        -- reference photo, admin only

-- Reference photos uploaded from the admin catalog (product shots, no patient data).
insert into storage.buckets (id, name, public) values ('skincare-products', 'skincare-products', true)
on conflict (id) do nothing;
drop policy if exists "admin_write_skincare_product_images" on storage.objects;
create policy "admin_write_skincare_product_images" on storage.objects
    for all to authenticated
    using (bucket_id = 'skincare-products' and public.is_admin())
    with check (bucket_id = 'skincare-products' and public.is_admin());

-- Treatment creams are suggested only for the concern they treat.
update public.skincare_products set concerns = '{spots,melasma}' where id = 'meso_brightening_cream';
update public.skincare_products set name = 'Healing Ointment', brand = 'Aquaphor' where id = 'eucerin_aquaphor';

update public.skincare_products p set
    format = v.format, key_actives = v.key_actives, us_available = v.us
from (values
    ('meso_purifying_mousse','espuma','Ácido salicílico + ácido láctico',true),
    ('lrp_effaclar_gel','gel','Zinc PCA (sin ácidos)',true),
    ('lrp_effaclar_medicated','gel','Ácido salicílico 2% + LHA',true),
    ('lrp_toleriane_hydrating','crema','Ceramida-3, niacinamida, glicerina',true),
    ('lrp_toleriane_caring','gel cremoso','Niacinamida, ceramida',false),
    ('eucerin_dermopure_gel','gel','Ácido salicílico suave',false),
    ('eucerin_hyaluron_gel','gel','Ácido hialurónico',false),
    ('isdin_acniben_gel','gel','Ácido salicílico',false),
    ('cerave_hydrating','loción','3 ceramidas + ácido hialurónico',true),
    ('cerave_foaming','gel espumoso','3 ceramidas + niacinamida',true),
    ('cerave_acne_bpo','crema espumosa','Peróxido de benzoilo 4%',true),
    ('avene_tolerance_cleanser','loción','Agua termal Avène',true),
    ('bioderma_sebium_gel','gel espumoso','Sulfato de zinc y cobre',true),
    ('cerave_cream_to_foam','crema que se vuelve espuma','3 ceramidas + aminoácidos',true),
    ('bioderma_sensibio_gel','gel espumoso','Complejo calmante, sin jabón',true),
    ('vanicream_gentle','gel','Sin fragancia ni colorantes',true),
    ('isdin_essential_oil','aceite','Aceites vegetales',true),
    ('lrp_micellar_ultra','agua micelar','Micelas + agua termal',true),
    ('lrp_effaclar_micellar','agua micelar','Micelas + zinc',true),
    ('bioderma_sensibio_h2o','agua micelar','Micelas, sin fragancia',true),
    ('eucerin_micellar','agua micelar','Ácido hialurónico',false),
    ('meso_ha_densimatrix','sérum','Ácido hialurónico de varios pesos',true),
    ('cs_barrier_pro','sérum en spray','Complejo adapDvate (barrera)',true),
    ('lrp_hyalu_b5','sérum','Ácido hialurónico + vitamina B5',true),
    ('eucerin_hf_serum','sérum','Ácido hialurónico',false),
    ('isdin_ha_concentrate','sérum (ampollas)','Ácido hialurónico',true),
    ('cerave_ha_serum','sérum','Ácido hialurónico + vitamina B5 + ceramidas',true),
    ('avene_hydrance_boost','sérum','Ácido hialurónico + agua termal',true),
    ('lrp_dermallergo_serum','sérum','Neurosensine, sin fragancia',false),
    ('lrp_rosaliac_ar','sérum-crema','Ambophenol (rojez)',false),
    ('meso_tran3x_concentrate','sérum concentrado','Ácido tranexámico + complejo despigmentante',true),
    ('lrp_mela_b3','sérum','Melasyl + niacinamida 10%',true),
    ('eucerin_antipigment_serum','sérum','Tiamidol + ácido hialurónico',false),
    ('isdin_melaclear','sérum','Ácido tranexámico + complejo despigmentante',true),
    ('sc_phloretin_cf','sérum','Vitamina C 10% + floretina 2% + ácido ferúlico 0.5%',true),
    ('sc_ce_ferulic','sérum','Vitamina C 15% + vitamina E 1% + ácido ferúlico 0.5%',true),
    ('lrp_vitc10','sérum','Vitamina C pura 10% + ácido salicílico',true),
    ('isdin_flavoc','sérum (ampollas)','Vitamina C + ginkgo biloba',true),
    ('eucerin_hf_vitc','sérum','Vitamina C 22%',false),
    ('lrp_niacinamide10','sérum','Niacinamida 10%',true),
    ('pc_niacinamide','sérum','Niacinamida 10%',true),
    ('to_niacinamide','sérum','Niacinamida 10% + zinc 1%',true),
    ('tretinoin_0025','crema','Tretinoína 0.025%',true),
    ('meso_skinretin','crema','Retinol 0.3% + bakuchiol',true),
    ('meso_blemiderm','gel-crema','Retinol + ácidos salicílico, mandélico y azelaico',true),
    ('meso_tran3x_gelcream','gel-crema','Ácido tranexámico + complejo despigmentante',true),
    ('lrp_retinol_b3','sérum','Retinol puro + niacinamida (B3)',true),
    ('avene_retrinal','crema','Retinaldehído 0.1%',true),
    ('sc_retinol03','crema','Retinol 0.3%',true),
    ('differin_adapalene','gel','Adapaleno 0.1%',true),
    ('inkey_bakuchiol','crema','Bakuchiol 1%',true),
    ('sc_discoloration','sérum','Ácido tranexámico 3% + niacinamida 5% + kójico 1%',true),
    ('eucerin_antipigment_night','crema','Tiamidol',false),
    ('azelaic_rx','gel','Ácido azelaico 15%',true),
    ('pc_azelaic','crema-gel','Ácido azelaico 10% + ácido salicílico',true),
    ('hydroquinone_4','crema','Hidroquinona 4%',true),
    ('pc_bha','líquido','Ácido salicílico 2%',true),
    ('eucerin_dermopure_serum','sérum','AHA + BHA',false),
    ('lrp_effaclar_serum','sérum','Ácidos salicílico + glicólico + LHA',false),
    ('isdin_night_peel','sérum','Ácidos glicólico + mandélico + málico',true),
    ('to_mandelic','sérum','Ácido mandélico 10% + ácido hialurónico',true),
    ('meso_hydravital_light','fluido','Activos hidratantes (factor K)',true),
    ('meso_hydracream_fusion','crema','Activos hidratantes',true),
    ('meso_brightening_cream','crema','Complejo despigmentante',true),
    ('meso_couperend','crema','Activos calmantes y vasoconstrictores (rojez)',true),
    ('lrp_double_repair','loción','Ceramida-3 + niacinamida + prebiótico',true),
    ('lrp_duo_m','gel-crema','Niacinamida + LHA + procerad',true),
    ('lrp_toleriane_sensitive','crema','Neurosensine + prebiótico',false),
    ('eucerin_dermopure_fluid','fluido','Ácido salicílico suave',false),
    ('eucerin_hf_cream','crema','Ácido hialurónico',false),
    ('eucerin_urea_face','crema','Urea 5%',false),
    ('isdin_hyaluronic_moisture','gel-crema','Ácido hialurónico (piel grasa)',true),
    ('cerave_pm_lotion','loción','3 ceramidas + niacinamida 4%',true),
    ('cerave_cream','crema','3 ceramidas + ácido hialurónico',true),
    ('avene_tolerance_control','crema','Postbiótico + agua termal',true),
    ('bioderma_sebium_hydra','crema','Activos hidratantes (piel grasa en tratamiento)',true),
    ('meso_melan_recovery','bálsamo-crema','Activos reparadores y calmantes',true),
    ('lrp_cicaplast_b5','bálsamo','Pantenol 5% + madecassoside',true),
    ('avene_cicalfate','crema','Cobre-zinc + sucralfato',true),
    ('bioderma_cicabio','crema','Hialuronato + cobre-zinc',true),
    ('eucerin_aquaphor','pomada','Petrolato 41% + pantenol',true),
    ('cerave_healing','pomada','Petrolato + ceramidas',true),
    ('meso_brightening_eye','crema de contorno','Complejo despigmentante',true),
    ('meso_antiwrinkle_eye','crema de contorno','Péptidos + bakuchiol',true),
    ('eucerin_antipigment_eye','crema de contorno','Tiamidol',false),
    ('lrp_pigmentclar_eyes','crema de contorno','Ácido ferúlico + cafeína',false),
    ('isdin_kox_eyes','crema de contorno','Vitamina K óxido + Haloxyl',true),
    ('eucerin_hf_eye','crema de contorno','Ácido hialurónico',false),
    ('sc_age_eye','crema de contorno','Proxylane + flavonoides',true),
    ('lrp_redermic_r_eyes','crema de contorno','Retinol',true),
    ('cerave_eye_repair','crema de contorno','Ceramidas + ácido hialurónico',true),
    ('cs_tinted','fluido con color','Óxido de zinc + dióxido de titanio + óxidos de hierro, SPF 50',true),
    ('cs_untinted','fluido','Filtros minerales',true),
    ('cs_brush_on','polvo mineral','Óxido de zinc + dióxido de titanio, SPF 50',true),
    ('meso_melan130','crema con color','Azeloglicina + filtros, SPF 50+',true),
    ('meso_mineral_fluid','fluido','Filtros minerales, SPF 50+',true),
    ('isdin_fusion_color','fluido con color','Filtros UE (no aprobados por la FDA)',false),
    ('heliocare_360_color','gel con color','Filtros UE (no aprobados por la FDA)',false),
    ('lrp_anthelios_mineral_tinted','fluido con color','Dióxido de titanio + óxido de zinc, SPF 50',true),
    ('eucerin_sun_pigment','fluido con color','Tiamidol + filtros UE',false),
    ('eltamd_uv_clear','fluido','Óxido de zinc 9% + niacinamida, SPF 46',true),
    ('meso_pure_renewing_mask','mascarilla','Caolín + ácidos salicílico y mandélico',true),
    ('meso_hydravital_mask','mascarilla','Activos hidratantes',true),
    ('meso_antistress_mask','mascarilla','Activos calmantes',true),
    ('avene_hydrance_mask','mascarilla','Ácido hialurónico + agua termal',true)
) as v(id, format, key_actives, us)
where p.id = v.id;

update public.skincare_products set shades = '{Fair,Light,Medium,Tan,Deep}' where id = 'cs_tinted';
update public.skincare_products set shades = '{Fair,Medium,Tan,Deep}' where id = 'cs_brush_on';
update public.skincare_products set shades = '{Universal}' where id in ('meso_melan130', 'lrp_anthelios_mineral_tinted');
update public.skincare_products set internal_notes = 'Tonos: confirmar con el stock de la clínica.' where id = 'cs_tinted' and internal_notes is null;
update public.skincare_products set internal_notes = 'Contiene retinoide y ácidos: cuenta como el retinoide de la rutina.' where id = 'meso_blemiderm' and internal_notes is null;
update public.skincare_products set internal_notes = 'Retinol: no combinar con tretinoína ni con otro retinoide.' where id = 'meso_skinretin' and internal_notes is null;
update public.skincare_products set internal_notes = 'Confirmar si es el "renewal eye contour" del stock.' where id = 'meso_antiwrinkle_eye' and internal_notes is null;
update public.skincare_products set internal_notes = 'Solo con receta; la indica un médico.' where is_prescription and internal_notes is null;
update public.skincare_products set internal_notes = 'Disponibilidad en EE. UU. sin confirmar (Ulta lo lista).' where id = 'lrp_duo_m' and internal_notes is null;

-- Reference photos (admin only), hotlinked from retailer CDNs. Editable in the admin catalog.
update public.skincare_products set name = 'Sunforgettable Total Protection Face Shield Flex SPF 50 (con color)' where id = 'cs_tinted';
update public.skincare_products p set image_url = v.url
from (values
 ('meso_antistress_mask','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/mesoestetic-anti-stress-mask.jpg?v=1631609519'),
 ('meso_antiwrinkle_eye','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/age-element_anti-wrinkle-eye-contour_primario.jpg?v=1695049733'),
 ('meso_blemiderm','https://cdn.shopify.com/s/files/1/0419/5447/6194/files/blemiderm_treatment_primario_secundario.jpg?v=1706613404'),
 ('meso_brightening_cream','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/age-element_brightening-cream_primario.jpg?v=1695049819'),
 ('meso_brightening_eye','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/age-element_anti-firming-eye-contour-prim_1.jpg?v=1656491224'),
 ('meso_couperend','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/bodegon_couperend.png?v=1695050317'),
 ('meso_ha_densimatrix','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/primario_ha_1024x1024_web.jpg?v=1695050819'),
 ('meso_hydracream_fusion','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/Mesoestetic-Hydracream-Fusion.jpg?v=1695050978'),
 ('meso_hydravital_light','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/bodegon_light_1024x1024_web.jpg?v=1695050944'),
 ('meso_hydravital_mask','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/hydravital-mask-100ml.jpg?v=1695051150'),
 ('meso_melan130','https://cdn.shopify.com/s/files/1/0419/5447/6194/files/mesoestetic-Mesoprotech-Melan-130-Pigment-Control_1698795b-c30f-4d05-aa38-8b9808474d4c.jpg?v=1716997873'),
 ('meso_melan_recovery','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/primario_melan_recovery_50ml.png?v=1695051196'),
 ('meso_mineral_fluid','https://cdn.shopify.com/s/files/1/0419/5447/6194/files/mesoprotech_mineral_fluid_primario.jpg?v=1724155199'),
 ('meso_pure_renewing_mask','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/Mesoestetic-Pure-Renewing-Mask.jpg?v=1631610646'),
 ('meso_purifying_mousse','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/Mesoestetic-Purifying-Mousse.jpg?v=1695051659'),
 ('meso_skinretin','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/skin-retin_0_3_primario_secundario.jpg?v=1669978335'),
 ('meso_tran3x_concentrate','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/primario_melan_concentrate_1024x1024_web.png?v=1695051235'),
 ('meso_tran3x_gelcream','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/mesoestetic-Melan-Tran3x-Daily-Depigmenting-Gel-Cream.jpg?v=1664199014'),
 ('cs_barrier_pro','https://cdn.shopify.com/s/files/1/0251/2184/9419/files/08_SiteUpdates_BPSerumSprayPDP.png?v=1755898875'),
 ('cs_tinted','https://cdn.shopify.com/s/files/1/0251/2184/9419/files/01_Flex_PDPHero_Update.png?v=1762269512'),
 ('cs_brush_on','https://cdn.shopify.com/s/files/1/0251/2184/9419/products/h0Kgc0dg.png?v=1762201989'),
 ('lrp_effaclar_gel','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/63666_la-roche-posay-effaclar-m-purifying-foaming-gel-400ml.webp?v=1729699154'),
 ('cerave_foaming','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/63925_cerave-foaming-cleanser-1000ml_ad071e33-7390-441d-b958-e44bfdb5aa5e.jpg?v=1729367667'),
 ('cerave_cream_to_foam','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/55965_3_252Fd_252F2_252F6_252F3d262e63fa06a64a733c727e4206c7ff6e510473_CeraVe_Hydrating_Cream_to_Foam_Cleanser___2_0ccbe616-2292-42a6-b92b-5fcdf8c57d38.jpg?v=1729362561'),
 ('isdin_essential_oil','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/62478_isdin-isdinceutics-essential-cleansing-200ml.png?v=1729367015'),
 ('lrp_micellar_ultra','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/62308_la-roche-posay-micellar-water-ultra-sensitive-skin-400ml_ba7c0af9-bf9e-4408-af1a-4ccfd3b4e15d.jpg?v=1751532103'),
 ('lrp_hyalu_b5','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/LaRoche-PosayHyaluB5SuractiveSerum30ml_b5b2d824-e5f8-4fb7-aaaf-30f79e955e31.webp?v=1760457760'),
 ('cerave_ha_serum','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/63731_cerave-hyaluronic-acid-serum-30ml_0ce11f8a-69c6-42af-8588-04f8dce5d5ff.jpg?v=1729699480'),
 ('lrp_mela_b3','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/63771_la-roche-posay-mela-b3-serum-30ml_d7d15403-4cf8-4b7c-82cc-8dbd3608bfbc.webp?v=1729699541'),
 ('sc_phloretin_cf','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/65418_skinceuticals-prevent-phloretin-cf-serum-30ml.png?v=1737031717'),
 ('sc_ce_ferulic','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/65400_skinceuticals-prevent_-c-e-ferulic-antioxidant-30ml.png?v=1737031491'),
 ('sc_retinol03','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/65412_skinceuticals-correct-retinol-0.3-anti-aging-night-cream-30ml.webp?v=1737031468'),
 ('sc_discoloration','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/65422_skinceuticals-discoloration-defense-serum-30ml.png?v=1737031657'),
 ('lrp_duo_m','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/63412_laroche-possay-effaclar-duo-m-40ml.webp?v=1729698473'),
 ('lrp_cicaplast_b5','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/62690_la-roche-posay-cicaplast-baume-b5-ultra-repairing-soothing-balm-100ml_9c3c92ee-1b7d-45bb-a249-66cbed642af3.webp?v=1729370142'),
 ('avene_cicalfate','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/62948_avene-cicalfate-repairing-emulsion-40ml_a1f6bb80-17b9-40cc-8d1c-92622dcaf746.jpg?v=1729368422'),
 ('eucerin_aquaphor','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/EucerinAquaphorRepairingOintment3x7ml.webp?v=1761309115'),
 ('isdin_kox_eyes','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/64534_isdin-isdinceutics-k-ox-eyes-cream-15g.jpg?v=1729357159'),
 ('lrp_redermic_r_eyes','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/62321_la-roche-posay-redermic-retinol-eyes-15ml.jpg?v=1729358739'),
 ('cerave_eye_repair','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/63921_cerave-eye-repair-cream-15ml_b717f08f-97d7-4c34-8564-4e3af12a9aac.jpg?v=1729370456'),
 ('isdin_hyaluronic_moisture','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/62655_isdin-isdinceutics-hyaluronic-moisture-cream-normal-to-dry-skin-50g_92ff53bf-8f62-4cfc-b007-a1d460c8736a.webp?v=1729369332'),
 ('avene_tolerance_control','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/60729_avenetolerancecontrolcreme-2.jpg?v=1721834832'),
 ('cerave_cream','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/CeraveCoreMoisturisingCream340g.webp?v=1761299271'),
 ('cerave_hydrating','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/CeraVeHydratingCleanser473ml_Refill473ml.webp?v=1770308400'),
 ('lrp_retinol_b3','https://cdn.shopify.com/s/files/1/0508/8316/6372/files/62353_la-roche-posay-retinol-b3-serum-30ml.jpg?v=1729357641'),
 ('bioderma_sebium_gel','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/Bioderma-Sebium-Foaming-Gel-500-ml.jpg?v=1784726150'),
 ('bioderma_sensibio_gel','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/Bioderma-Sensibio-Foaming-Gel-200-ml.jpg?v=1784732887'),
 ('isdin_ha_concentrate','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/ISDIN-Hyaluronic-Concentrate-30ml.png?v=1783695411'),
 ('avene_hydrance_boost','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/Avene-Hydrance-BOOST-Concentrated-Hydrating-Serum-1-fl-oz.jpg?v=1786474072'),
 ('isdin_melaclear','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/ISDIN-Melaclear-Advanced-50-mL.png?v=1783695973'),
 ('isdin_flavoc','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/ISDIN-Flavo-C-30-mL.png?v=1783699125'),
 ('avene_retrinal','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/Avene-Retrinal-0.1-Percent-Intensive-Multi-Corrective-Cream-1-fl-oz.jpg?v=1786467567'),
 ('bioderma_sebium_hydra','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/Bioderma-Bioderma-Sebium-Hydra-40ml.jpg?v=1784725502'),
 ('bioderma_cicabio','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/Bioderma-Cicabio-Cream-Plus-40ml.jpg?v=1784575780'),
 ('eltamd_uv_clear','https://cdn.shopify.com/s/files/1/0706/0819/1657/files/EltaMD-UV-Clear-Broad-Spectrum-SPF-46-1.7-oz.png?v=1782318275'),
 ('avene_tolerance_cleanser','https://cdn.shopify.com/s/files/1/0419/5447/6194/files/u5wa3z31qn5sj3otasr4g38ciocmkyegqo3bqiy.jpg?v=1760972048')
) as v(id, url)
where p.id = v.id and p.image_url is null;

-- ---------- v4 (2026-11-20): approximate US price + size, mesoestetic US line ----------
-- Prices are approximate US retail (USD) for orientation only; edit them in the admin catalog.
alter table public.skincare_products add column if not exists price_usd numeric(8,2);
alter table public.skincare_products add column if not exists size text;   -- "50 ml", "10 x 2 ml"

-- Corrections from the mesoestetic US guide ("soluciones domiciliarias").
update public.skincare_products set step = 'cleanser', skin_types = '{normal,dry,sensitive}', concerns = '{dehydration,redness}',
    format = 'crema-aceite limpiadora', key_actives = 'Postbióticos, anti-polución', usage = 'Masajear sobre la piel y retirar con agua.'
    where id = 'meso_hydracream_fusion';
update public.skincare_products set tinted = true, shades = '{Universal}', key_actives = 'Filtros minerales, SPF 50, con color'
    where id = 'meso_mineral_fluid';
update public.skincare_products set concerns = '{spots,texture}', classes = '{antioxidant}', key_actives = 'Activos iluminadores multi-antioxidantes'
    where id = 'meso_brightening_cream';
update public.skincare_products set concerns = '{eye_pigment,eye_vascular}', classes = '{}', key_actives = 'Activos iluminadores; aplicador cerámico efecto frío'
    where id = 'meso_brightening_eye';
update public.skincare_products set concerns = '{eye_wrinkles,eye_vascular}', key_actives = 'Péptidos + bakuchiol; aplicador cerámico efecto frío'
    where id = 'meso_antiwrinkle_eye';
update public.skincare_products set key_actives = 'Retinol puro 0.3% + bakuchiol 0.7%' where id = 'meso_skinretin';
update public.skincare_products set us_available = false, internal_notes = 'No aparece en la guía mesoestetic EE. UU.' where id = 'meso_hydravital_mask';

-- mesoestetic US products that were missing.
insert into public.skincare_products
    (id, name, brand, step, skin_types, concerns, classes, time_of_day, in_stock, is_prescription, pregnancy, irritation, tinted, usage, format, key_actives, us_available)
values
('meso_brightening_foam','Brightening Foam','mesoestetic','cleanser','{normal,combination}','{texture,spots}','{aha}','both',false,false,'consult',1,false,null,'espuma cremosa','Ácidos glicólico + láctico (AHA)',true),
('meso_hydratonic_mist','Hydratonic Mist (tónico en bruma, opcional)','mesoestetic','serum','{normal,combination,oily,dry,sensitive}','{dehydration}','{}','both',false,false,'safe',0,false,'Pulverizar sobre el rostro limpio antes del sérum.','tónico en bruma','Hidratante, equilibrante, anti-polución',true),
('meso_factor_k','Hydra-Vital Factor K','mesoestetic','moisturizer','{normal,dry}','{dehydration}','{}','both',false,false,'safe',0,false,null,'crema rica','Vitamina E + activos nutritivos',true),
('meso_skin_balance','Skin Balance (sérum calmante)','mesoestetic','serum','{normal,combination,dry,sensitive}','{redness,dehydration}','{barrier}','both',false,false,'safe',0,false,null,'sérum','Activos calmantes; refuerza microbiota y barrera',true),
('meso_brightening_concentrate','Age Element Brightening Concentrate','mesoestetic','active_am','{normal,combination,oily,dry}','{texture,spots}','{antioxidant}','both',false,false,'consult',0,false,null,'sérum concentrado','Activos iluminadores + antioxidantes',true),
('meso_firming_concentrate','Age Element Firming Concentrate','mesoestetic','serum','{normal,combination,dry}','{wrinkles}','{peptide}','both',false,false,'consult',0,false,null,'sérum concentrado','Activos reafirmantes (efecto lifting)',true),
('meso_firming_cream','Age Element Firming Cream','mesoestetic','moisturizer','{normal,combination,dry}','{wrinkles}','{peptide}','both',false,false,'consult',0,false,null,'crema','Activos reafirmantes (flacidez, óvalo facial)',true),
('meso_antiwrinkle_cream','Age Element Anti-Wrinkle Cream','mesoestetic','moisturizer','{normal,combination,dry}','{wrinkles}','{peptide}','both',false,false,'consult',0,false,null,'crema','Activos antiarrugas y alisadores',true),
('meso_aox_ferulic','AOX Ferulic','mesoestetic','active_am','{normal,combination,oily,dry}','{wrinkles,spots,texture}','{antioxidant}','am',false,false,'safe',0,false,null,'sérum concentrado','Ácido ferúlico + glutatión + astaxantina',true),
('meso_blemiderm_resurfacing','Blemiderm Resurfacing Gel','mesoestetic','active_pm','{combination,oily}','{acne,shine,texture}','{bha,aha}','pm',false,false,'consult',2,false,'Noches alternas al empezar; nunca la misma noche que un retinoide.','gel','Ácido salicílico + ácido glicólico',true),
('meso_fast_skin_repair','Fast Skin Repair','mesoestetic','repair','{normal,combination,dry,sensitive}','{redness}','{barrier}','both',false,false,'safe',0,false,null,'crema','Activos regeneradores (piel sensibilizada)',true),
('meso_ultimate_micropeel','Ultimate Micropeel','mesoestetic','active_pm','{normal,combination,oily}','{texture,spots}','{aha}','pm',false,false,'consult',1,false,'2 a 3 noches por semana con un algodón; nunca la misma noche que un retinoide.','loción bifásica','AHA (micro-exfoliante)',true),
('meso_water_veil','Mesoprotech Water Veil SPF 50+','mesoestetic','spf','{combination,oily}','{shine,acne}','{}','am',false,false,'safe',0,false,'Último paso de la mañana. Reaplicar cada 2 a 3 horas si hay exposición.','gel-crema ligero','SPF 50+, no comedogénico',true)
on conflict (id) do update set
    name = excluded.name, step = excluded.step, skin_types = excluded.skin_types, concerns = excluded.concerns, classes = excluded.classes,
    time_of_day = excluded.time_of_day, pregnancy = excluded.pregnancy, irritation = excluded.irritation, usage = excluded.usage,
    format = excluded.format, key_actives = excluded.key_actives, us_available = excluded.us_available;

update public.skincare_products p set price_usd = v.price, size = v.size
from (values
 -- mesoestetic (precio en EE. UU., tienda Face the Future US; presentación de la guía)
 ('meso_purifying_mousse',47,'150 ml'),('meso_hydracream_fusion',40,'100 ml'),('meso_brightening_foam',40,'100 ml'),('meso_hydratonic_mist',47,'125 ml'),
 ('meso_hydravital_light',81,'50 ml'),('meso_factor_k',77,'50 ml'),('meso_ha_densimatrix',115,'30 ml'),('meso_skin_balance',115,'30 ml'),
 ('meso_brightening_concentrate',136,'30 ml'),('meso_brightening_eye',76,'15 ml'),('meso_brightening_cream',103,'50 ml'),
 ('meso_firming_concentrate',136,'30 ml'),('meso_firming_cream',116,'50 ml'),('meso_antiwrinkle_cream',129,'50 ml'),('meso_antiwrinkle_eye',103,'15 ml'),
 ('meso_aox_ferulic',97,'15 ml'),('meso_skinretin',131,'50 ml'),('meso_blemiderm',82,'50 ml'),('meso_blemiderm_resurfacing',82,'50 ml'),
 ('meso_pure_renewing_mask',54,'100 ml'),('meso_tran3x_concentrate',145,'30 ml'),('meso_tran3x_gelcream',108,'50 ml'),
 ('meso_antistress_mask',68,'100 ml'),('meso_fast_skin_repair',66,'50 ml'),('meso_couperend',65,'50 ml'),('meso_melan_recovery',86,'50 ml'),
 ('meso_ultimate_micropeel',74,'150 ml'),('meso_melan130',67,'50 ml'),('meso_water_veil',66,'50 ml'),('meso_mineral_fluid',66,'50 ml'),
 -- otras marcas (precio de lista aproximado en EE. UU.)
 ('lrp_effaclar_gel',20,'200 ml'),('lrp_effaclar_medicated',20,'200 ml'),('lrp_toleriane_hydrating',18,'400 ml'),('cerave_hydrating',18,'473 ml'),
 ('cerave_foaming',18,'473 ml'),('cerave_acne_bpo',15,'150 ml'),('avene_tolerance_cleanser',30,'200 ml'),('bioderma_sebium_gel',25,'500 ml'),
 ('cerave_cream_to_foam',16,'236 ml'),('bioderma_sensibio_gel',20,'200 ml'),('vanicream_gentle',11,'237 ml'),('isdin_essential_oil',40,'200 ml'),
 ('lrp_micellar_ultra',18,'400 ml'),('lrp_effaclar_micellar',18,'400 ml'),('bioderma_sensibio_h2o',22,'500 ml'),
 ('cs_barrier_pro',65,'75 ml'),('lrp_hyalu_b5',45,'30 ml'),('isdin_ha_concentrate',115,'30 ml'),('cerave_ha_serum',20,'30 ml'),('avene_hydrance_boost',42,'30 ml'),
 ('lrp_mela_b3',50,'30 ml'),('isdin_melaclear',180,'50 ml'),('sc_phloretin_cf',182,'30 ml'),('sc_ce_ferulic',182,'30 ml'),('lrp_vitc10',45,'30 ml'),('isdin_flavoc',115,'30 ml'),
 ('lrp_niacinamide10',40,'30 ml'),('pc_niacinamide',49,'20 ml'),('to_niacinamide',6,'30 ml'),
 ('lrp_retinol_b3',45,'30 ml'),('avene_retrinal',68,'30 ml'),('sc_retinol03',78,'30 ml'),('differin_adapalene',16,'45 g'),('inkey_bakuchiol',13,'30 ml'),
 ('sc_discoloration',108,'30 ml'),('pc_azelaic',40,'30 ml'),('pc_bha',35,'118 ml'),('isdin_night_peel',110,'30 ml'),('to_mandelic',8,'30 ml'),
 ('lrp_double_repair',23,'75 ml'),('lrp_duo_m',33,'40 ml'),('isdin_hyaluronic_moisture',55,'50 g'),('cerave_pm_lotion',19,'89 ml'),('cerave_cream',20,'453 g'),
 ('avene_tolerance_control',40,'40 ml'),('bioderma_sebium_hydra',26,'40 ml'),
 ('lrp_cicaplast_b5',16,'40 ml'),('avene_cicalfate',30,'40 ml'),('bioderma_cicabio',21,'40 ml'),('eucerin_aquaphor',8,'50 g'),('cerave_healing',14,'85 g'),
 ('isdin_kox_eyes',106,'15 g'),('sc_age_eye',108,'15 ml'),('lrp_redermic_r_eyes',60,'15 ml'),('cerave_eye_repair',17,'14 ml'),
 ('cs_tinted',55,'55 ml'),('cs_brush_on',69,'6 g'),('lrp_anthelios_mineral_tinted',37,'50 ml'),('eltamd_uv_clear',46,'48 g'),('avene_hydrance_mask',40,'50 ml'),
 ('tretinoin_0025',50,'20 g')
) as v(id, price, size)
where p.id = v.id;
update public.skincare_products set internal_notes = coalesce(internal_notes || ' ', '') || 'Precio sin seguro, varía por farmacia.' where id = 'tretinoin_0025' and coalesce(internal_notes,'') not like '%Precio sin seguro%';

update public.skincare_products p set image_url = v.url
from (values
 ('meso_brightening_foam','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/Mesoestetic-Brightening-Foam.jpg?v=1695050172'),
 ('meso_hydratonic_mist','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/Mesoestetic-Hydratonic-Mist.jpg?v=1695051110'),
 ('meso_factor_k','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/bodegon_k_1024x1024_web_1.jpg?v=1695050893'),
 ('meso_skin_balance','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/Mesoestetic-Skin-Balance4.jpg?v=1646907616'),
 ('meso_brightening_concentrate','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/age-element_brigtheningconcentrate_prim.jpg?v=1656487922'),
 ('meso_firming_concentrate','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/age-element_firming-concentrate_primario.jpg?v=1656504082'),
 ('meso_firming_cream','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/age-element_firming-cream_primario.jpg?v=1695049880'),
 ('meso_antiwrinkle_cream','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/age-element_anti-wrinkle-cream_1.jpg?v=1695049712'),
 ('meso_aox_ferulic','https://cdn.shopify.com/s/files/1/0419/5447/6194/files/bodeg_n_aox.png?v=1733414595'),
 ('meso_blemiderm_resurfacing','https://cdn.shopify.com/s/files/1/0419/5447/6194/files/mesoestetic-Blemiderm-Resurfacing-Gel.jpg?v=1779192250'),
 ('meso_fast_skin_repair','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/bodegon_fast_skin_repair.png?v=1695050779'),
 ('meso_ultimate_micropeel','https://cdn.shopify.com/s/files/1/0419/5447/6194/products/Mesoestetic-Ultimate-Micropeel.jpg?v=1695051940'),
 ('meso_water_veil','https://cdn.shopify.com/s/files/1/0419/5447/6194/files/mesoestetic-Mesoprotech-Light-Water-Antiaging-Veil-SPF-50.jpg?v=1712134596')
) as v(id, url)
where p.id = v.id and p.image_url is null;

-- age element anti-wrinkle eye contour = "age element renewal eye contour" (current US name).
update public.skincare_products set name = 'Age Element Renewal Eye Contour (antes Anti-Wrinkle)',
    internal_notes = nullif(replace(coalesce(internal_notes, ''), 'Confirmar si es el "renewal eye contour" del stock.', ''), '')
    where id = 'meso_antiwrinkle_eye';

-- Piel Spa's own selling price (in-stock products), separate from the market reference price.
alter table public.skincare_products add column if not exists clinic_price_usd numeric(8,2);

update public.skincare_products set price_usd = 55, size = coalesce(size, '50 ml'),
    internal_notes = coalesce(internal_notes || ' ', '') || 'Precio de la línea Face Shield; confirmar producto exacto.'
    where id = 'cs_untinted' and price_usd is null;
update public.skincare_products set price_usd = 80, size = coalesce(size, '50 g'),
    internal_notes = coalesce(internal_notes || ' ', '') || 'Genérico sin seguro, varía por farmacia.'
    where id = 'azelaic_rx' and price_usd is null;
update public.skincare_products set price_usd = 50, size = coalesce(size, '28 g'),
    internal_notes = coalesce(internal_notes || ' ', '') || 'Genérico sin seguro, varía por farmacia.'
    where id = 'hydroquinone_4' and price_usd is null;

-- mesoestetic USA price list, September 2026: RETAIL (reference price) and PROF (clinic cost).
alter table public.skincare_products add column if not exists cost_usd numeric(8,2);   -- what Piel Spa pays (admin only)

update public.skincare_products p set price_usd = v.retail, cost_usd = v.prof, size = v.size
from (values
 ('meso_brightening_cream',92.99,51.00,'50 ml'),('meso_brightening_eye',69.99,39.00,'15 ml'),('meso_brightening_concentrate',107.00,59.00,'30 ml'),
 ('meso_firming_cream',94.99,52.00,'50 ml'),('meso_firming_concentrate',115.99,64.00,'30 ml'),
 ('meso_antiwrinkle_cream',117.99,65.00,'50 ml'),('meso_antiwrinkle_eye',89.00,49.00,'15 ml'),
 ('meso_skinretin',116.99,65.00,'50 ml'),('meso_aox_ferulic',99.00,55.00,'15 ml'),
 ('meso_hydracream_fusion',35.00,22.50,'100 ml'),('meso_brightening_foam',35.00,22.50,'100 ml'),('meso_purifying_mousse',39.99,24.50,'150 ml'),('meso_hydratonic_mist',39.00,24.00,'125 ml'),
 ('meso_factor_k',82.00,45.00,'50 ml'),('meso_hydravital_light',70.00,39.00,'50 ml'),('meso_ha_densimatrix',109.99,61.00,'30 ml'),
 ('meso_antistress_mask',73.00,40.00,'100 ml'),('meso_fast_skin_repair',73.00,40.00,'50 ml'),('meso_couperend',73.00,40.00,'50 ml'),('meso_melan_recovery',79.99,44.00,'50 ml'),('meso_skin_balance',105.00,58.00,'30 ml'),
 ('meso_pure_renewing_mask',59.00,33.00,'100 ml'),('meso_blemiderm_resurfacing',79.00,48.00,'50 ml'),('meso_blemiderm',79.00,48.00,'50 ml'),
 ('meso_ultimate_micropeel',72.00,40.00,'150 ml'),('meso_tran3x_concentrate',129.99,72.00,'30 ml'),('meso_tran3x_gelcream',84.50,47.00,'50 ml'),
 ('meso_melan130',63.00,35.00,'50 ml'),('meso_mineral_fluid',63.00,35.00,'50 ml'),('meso_water_veil',63.00,35.00,'50 ml')
) as v(id, retail, prof, size)
where p.id = v.id;

-- Hydra-Vital Mask is a professional (cabina) 500 ml product in the US list.
update public.skincare_products set internal_notes = 'Solo profesional (cabina, 500 ml) en EE. UU.; no es de uso en casa.' where id = 'meso_hydravital_mask';

update public.skincare_products set image_url = 'https://cdn.shopify.com/s/files/1/0419/5447/6194/products/5671.jpg?v=1740391709' where id = 'to_niacinamide' and image_url is null;
update public.skincare_products set internal_notes = coalesce(internal_notes || ' ', '') || 'Ya no aparece en la tienda oficial de The Inkey List: posible descontinuado.' where id = 'inkey_bakuchiol' and coalesce(internal_notes,'') not like '%descontinuado%';

-- Photos supplied by Piel Spa (uploaded to the skincare-products bucket).
update public.skincare_products p set image_url = 'https://qkjmrnqkoipdltauweub.supabase.co/storage/v1/object/public/skincare-products/' || v.f
from (values ('lrp_toleriane_hydrating','lrp_toleriane_hydrating.png'),('lrp_effaclar_medicated','lrp_effaclar_medicated.png'),('lrp_vitc10','lrp_vitc10.png'),
 ('lrp_niacinamide10','lrp_niacinamide10.png'),('lrp_double_repair','lrp_double_repair.png'),('lrp_anthelios_mineral_tinted','lrp_anthelios_mineral_tinted.png'),
 ('cerave_acne_bpo','cerave_acne_bpo.png'),('cerave_pm_lotion','cerave_pm_lotion.webp'),('cerave_healing','cerave_healing.png')) as v(id, f)
where p.id = v.id;
-- La Roche-Posay replaced Pure Vitamin C10 with Vitamin C12 Serum in the US.
update public.skincare_products set name = 'Vitamin C12 Serum', key_actives = 'Vitamina C pura 12% + ácido salicílico', price_usd = 50 where id = 'lrp_vitc10';
update public.skincare_products set size = '144 g' where id = 'cerave_healing';

-- 2026-11-21: morning/night use per product (morning-only and night-only stay as they are)
-- and when to use Tran3x Concentrate vs Gel Cream.
update public.skincare_products set time_of_day = 'both'
    where id in ('meso_tran3x_gelcream', 'lrp_mela_b3', 'meso_brightening_concentrate', 'lrp_niacinamide10', 'pc_niacinamide', 'to_niacinamide',
                 'meso_ha_densimatrix', 'meso_skin_balance', 'meso_firming_concentrate', 'pc_azelaic', 'azelaic_rx', 'sc_discoloration', 'meso_tran3x_concentrate');
update public.skincare_products set internal_notes =
    'Sérum intensivo: manchas marcadas o inicio del tratamiento. Mañana y/o noche, antes de la crema. Se combina con el Gel Cream (Concentrate primero).'
    where id = 'meso_tran3x_concentrate';
update public.skincare_products set internal_notes =
    'Crema diaria de mantenimiento: tono uniforme y evitar que vuelvan las manchas. Sola de noche o encima del Concentrate; también sirve de hidratante tratante.'
    where id = 'meso_tran3x_gelcream';
