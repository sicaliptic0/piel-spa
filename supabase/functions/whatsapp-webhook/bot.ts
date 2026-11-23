import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CLINIC_TIME_ZONE, clinicDate, formatTime12h } from "../_shared/clinic.ts";
import { clinicPlaces, dayEs, placeFor } from "../_shared/appointmentText.ts";
import { sendWhatsAppMessage } from "../_shared/whatsapp.ts";
import { sendPushToStaff } from "../_shared/push.ts";
import { startReschedule } from "./reschedule.ts";
import { matchMenuIntent } from "./intent.ts";

// WhatsApp assistant: catalog-backed menus, with intent matching in test mode.
//
// Answers only while wa_bot_handles() is true: the bot is on (wa_settings.bot_enabled)
// or the number is in wa_settings.bot_test_phones, and the chat is not with a
// person (wa_conversations.bot_active). When staff writes — from the panel or
// the phone — bot_active turns false and the bot stays quiet in that chat until
// "Resolver · reactivar IA".
//
// Language and location (saved on the chat as bot_lang / bot_location):
//   - Known patients: language detected from what they write (Spanish when it
//     can't tell); location from their latest appointment, else their profile's
//     clinic_affiliation ("divine" → Divine Bliss, "fs" → Piel Spa).
//   - Unknown numbers: asked "Español / English", then "Piel Spa Manhattan /
//     Divine Bliss NJ".
//   - Divine Bliss: no promotion and no menu — the chat goes straight to staff
//     (told it's outside hours when it is).
//   - Piel Spa Manhattan: the promotion (wa_settings.promo_text / promo_text_en)
//     and the menu: a question, services and prices (asking first what they want
//     to treat; only sale_services rows marked bot_visible), booking, talking to
//     someone, my appointments, location and hours.
// Health questions, photos, complaints, payments, post-treatment problems and
// anything it doesn't understand go to staff ("Por responder") with a push
// saying why. Row/button ids: bot:<action>[:<arg>].

// deno-lint-ignore no-explicit-any
type Json = any;
type Lang = "es" | "en";
type Loc = "piel_spa" | "divine_bliss";

const BOOKING_URL = "https://piel-spa.com/agendar.html";
const MAPS_URL = "https://maps.app.goo.gl/?q=481+8th+Ave+Suite+1221+New+York+NY+10001";

type Hours = { days: number[]; open: string; close: string };
type Settings = { promo_text: string; promo_text_en: string; human_hours: Hours; product_discount: number; test_phones: string[]; test_mode: boolean };
type Conv = {
  id: string; patient_id: string | null; profile_name: string | null; bot_state: string | null; bot_greeted_at: string | null;
  bot_lang: Lang | null; bot_location: Loc | null;
};

// ---------- text matching ----------
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Stems match at the start of a word ("embaraz" → "embarazada"; "hi" never
// inside "chin"). Emojis match anywhere.
const has = (t: string, words: string[]) => words.some((w) =>
  /^[\p{L}\p{N}' ]+$/u.test(w) ? new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}`, "u").test(t) : t.includes(w));
// Whole words only (greetings, thanks: "ok" must not match "book").
const hasWord = (t: string, words: string[]) => words.some((w) =>
  /^[\p{L}\p{N}' ]+$/u.test(w) ? new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, "u").test(t) : t.includes(w));
const countWords = (t: string, words: string[]) => words.filter((w) => hasWord(t, [w])).length;

const URGENT = ["no puedo respirar", "me falta el aire", "cant breathe", "can't breathe", "vision borrosa", "veo borroso", "perdi la vision",
  "no veo", "piel blanca", "se puso blanca", "se puso morada", "emergencia", "emergency", "911", "blurry vision", "turned white"];
const AFTER_CARE = ["hinchaz", "hinchad", "inflamad", "moreton", "morado", "hematoma", "me duele", "dolor", "ardor", "quemadura", "reaccion",
  "molestia", "swelling", "swollen", "bruise", "pain", "hurts", "infecc", "infect", "fiebre", "fever", "burn", "rash"];
const MEDICAL = ["embaraz", "lactan", "amamant", "pregnan", "breastfeed", "medicament", "pastilla", "alergi", "allerg", "isotretino", "accutane",
  "roacutan", "anticoagul", "warfarin", "blood thinner", "herpes", "diabet", "cancer", "quimio", "chemo", "enfermedad", "autoinmun", "autoimmun",
  "lupus", "tiroides", "thyroid", "presion alta", "marcapaso", "pacemaker", "piel sensible", "sensitive skin", "rosacea", "dermatitis",
  "piel muy sensible", "muy sensible", "very sensitive", "nursing", "es seguro", "is it safe", "contraindic", "puedo hacerme", "me lo puedo hacer", "medication"];
const COMPLAINT = ["queja", "reclamo", "mala experiencia", "mal servicio", "no me gusto", "molesta", "complaint", "terrible", "estafa", "bad experience"];
const PAYMENT = ["reembolso", "devolucion", "refund", "me cobraron", "cobro", "factura", "pagar", "pago", "zelle", "tarjeta", "deposito",
  "payment", "deposit", "charged", "invoice"];
const HUMAN = ["humano", "persona", "alguien", "asesor", "agente", "operador", "llamar", "llamada", "hablar con", "human", "agent",
  "representative", "someone", "real person", "doctor", "doctora", "medico", "call me", "talk to"];
const GREETING = ["hola", "buenas", "buenos dias", "buen dia", "saludos", "hi", "hello", "hey", "info", "informacion", "information", "menu",
  "inicio", "start", "opciones", "options", "good morning", "good afternoon"];
const THANKS = ["gracias", "muchas gracias", "thanks", "thank you", "ok", "okay", "perfecto", "perfect", "listo", "genial", "great",
  "excelente", "👍", "❤", "🙏", "super"];
const SERVICES = ["precio", "cuanto", "cuesta", "costo", "servicio", "tratamiento", "promo", "oferta", "descuento", "black friday",
  "botox", "toxina", "facial", "relleno", "labio", "peeling", "mancha", "acne", "microneedling", "microagujas", "sculptra", "endolaser",
  "papada", "depilacion", "laser", "price", "cost", "how much", "service", "treatment", "discount", "filler", "lip"];
const BOOK = ["cita", "agendar", "agenda", "reservar", "reserva", "turno", "disponib", "appointment", "book", "schedule", "availab"];
const INFO = ["donde", "direccion", "ubicacion", "ubicados", "como llego", "estacionamiento", "parking", "horario", "abren", "address",
  "location", "hours", "where", "open"];
const PRODUCTS = ["producto", "comprar", "protector solar", "crema", "serum", "limpiador", "rutina", "skincare", "product", "sunscreen", "cleanser", "moisturizer", "routine", "buy"];

// Language of a message: which list it matches more. null when it can't tell.
const EN_WORDS = ["hi", "hello", "hey", "how", "much", "price", "prices", "appointment", "book", "want", "would", "like", "the", "you", "your",
  "is", "are", "do", "does", "what", "where", "when", "please", "thanks", "thank", "good", "morning", "available", "english", "cost", "can", "i", "my", "need"];
const ES_WORDS = ["hola", "buenas", "buenos", "cuanto", "precio", "precios", "cita", "quiero", "quisiera", "gracias", "favor", "que", "donde",
  "cuando", "como", "tienen", "informacion", "espanol", "necesito", "puedo", "el", "la", "los", "las", "de", "una", "un", "mi", "para", "tengo"];
function detectLang(text: string): Lang | null {
  const t = norm(text);
  const en = countWords(t, EN_WORDS), es = countWords(t, ES_WORDS);
  return en > es ? "en" : es > en ? "es" : null;
}

// ---------- wording ----------
const L = (lang: Lang, es: string, en: string) => lang === "en" ? en : es;
const CATEGORY_EN: Record<string, string> = {
  "consulta": "Consultation", "mantenimiento de mi piel": "Skin maintenance", "manchas y melasma": "Dark spots & melasma",
  "acne y brotes": "Acne & breakouts", "textura y poros": "Texture & pores", "relajacion y drenaje": "Relaxation & drainage",
  "arrugas": "Wrinkles", "flacidez": "Sagging skin", "luminosidad e hidratacion": "Radiance & hydration",
  "perdida de volumen": "Volume loss", "ojeras": "Under-eye circles", "vello no deseado": "Unwanted hair",
};
const catName = (cat: string, lang: Lang) => lang === "en" ? (CATEGORY_EN[norm(cat)] ?? cat) : cat;

function dayText(iso: string, lang: Lang): string {
  if (lang === "es") return dayEs(iso);
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

// ---------- settings, hours ----------
async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data } = await db.from("wa_settings").select("bot_enabled, bot_test_phones, promo_text, promo_text_en, promo_ends_on, product_promo_percent, product_promo_ends_on, human_hours").eq("id", 1).maybeSingle();
  const expired = data?.promo_ends_on && data.promo_ends_on < clinicDate(0);
  return {
    promo_text: expired ? "" : String(data?.promo_text ?? "").trim(),
    promo_text_en: expired ? "" : String(data?.promo_text_en ?? "").trim(),
    product_discount: (data?.product_promo_ends_on || "") >= clinicDate(0) ? Number(data?.product_promo_percent) || 0 : 0,
    test_phones: data?.bot_test_phones ?? [],
    test_mode: data?.bot_enabled === false,
    human_hours: data?.human_hours ?? { days: [1, 2, 3, 4, 5, 6], open: "09:00", close: "19:00" },
  };
}
const promoFor = (s: Settings, lang: Lang) => lang === "en" ? s.promo_text_en : s.promo_text;

function nowInClinic(): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TIME_ZONE, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), hhmm: `${get("hour")}:${get("minute")}` };
}
export function withinHumanHours(h: Hours): boolean {
  const { weekday, hhmm } = nowInClinic();
  return (h.days || []).includes(weekday) && hhmm >= h.open && hhmm < h.close;
}
const DAY_NAMES: Record<Lang, string[]> = {
  es: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};
function hoursText(h: Hours, lang: Lang): string {
  const d = [...(h.days || [])].sort();
  const names = DAY_NAMES[lang];
  const consecutive = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const days = consecutive
    ? L(lang, `de ${names[d[0]]} a ${names[d[d.length - 1]]}`, `${names[d[0]]} to ${names[d[d.length - 1]]}`)
    : d.map((x) => names[x]).join(", ");
  return L(lang, `${days}, de ${formatTime12h(h.open)} a ${formatTime12h(h.close)}`, `${days}, ${formatTime12h(h.open)} to ${formatTime12h(h.close)}`);
}

// ---------- sending ----------
async function send(db: SupabaseClient, conv: Conv, waId: string, payload: Record<string, unknown>, copy: string) {
  let waMessageId = "";
  let sendError = "";
  try {
    waMessageId = await sendWhatsAppMessage(waId, payload);
  } catch (e) {
    sendError = (e as Error).message;
    console.error("bot send:", sendError);
  }
  await db.from("wa_messages").insert({
    conversation_id: conv.id, direction: "out", sender: "bot", body: copy,
    wa_message_id: waMessageId || null, status: sendError ? "failed" : "sent", error: sendError || null,
  });
}
const sendText = (db: SupabaseClient, conv: Conv, waId: string, body: string) => send(db, conv, waId, { type: "text", text: { body } }, body);

type Btn = { id: string; title: string };
function sendButtons(db: SupabaseClient, conv: Conv, waId: string, body: string, buttons: Btn[]) {
  return send(db, conv, waId, {
    type: "interactive",
    interactive: { type: "button", body: { text: body }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } },
  }, [body, ...buttons.map((b) => `[${b.title}]`)].join("\n"));
}
type Row = { id: string; title: string; description?: string };
function sendList(db: SupabaseClient, conv: Conv, waId: string, body: string, button: string, rows: Row[], lang: Lang) {
  const clean = rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) }));
  return send(db, conv, waId, {
    type: "interactive",
    interactive: { type: "list", body: { text: body }, action: { button: button.slice(0, 20), sections: [{ title: L(lang, "Opciones", "Options"), rows: clean }] } },
  }, [body, ...clean.map((r) => `• ${r.title}`)].join("\n"));
}

async function saveConv(db: SupabaseClient, conv: Conv, fields: Partial<Conv> & Record<string, unknown>) {
  Object.assign(conv, fields);
  await db.from("wa_conversations").update(fields).eq("id", conv.id);
}
const setState = (db: SupabaseClient, conv: Conv, state: string | null) =>
  saveConv(db, conv, { bot_state: state, bot_state_at: new Date().toISOString() });

async function firstName(db: SupabaseClient, conv: Conv): Promise<string> {
  if (!conv.patient_id) return "";
  const { data } = await db.from("profiles").select("first_name").eq("id", conv.patient_id).maybeSingle();
  const n = String(data?.first_name || "").trim().split(/\s+/)[0] || "";
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : "";
}

// Where a known patient is treated: latest appointment, else profile affiliation.
async function patientLocation(db: SupabaseClient, patientId: string): Promise<Loc | null> {
  const { data: appt } = await db.from("appointments").select("location")
    .eq("patient_id", patientId).neq("status", "cancelled")
    .order("appointment_date", { ascending: false }).order("appointment_time", { ascending: false }).limit(1).maybeSingle();
  if (appt?.location === "divine_bliss" || appt?.location === "piel_spa") return appt.location;
  const { data: p } = await db.from("profiles").select("clinic_affiliation").eq("id", patientId).maybeSingle();
  const aff: string[] = Array.isArray(p?.clinic_affiliation) ? p.clinic_affiliation : [];
  if (aff.includes("fs")) return "piel_spa";
  if (aff.includes("divine")) return "divine_bliss";
  return null;
}

// ---------- first contact: language, location ----------
const trialNote = (s: Settings, lang: Lang) => s.test_mode ? L(lang, "Asistente virtual · versión de prueba\n\n", "Virtual assistant · trial version\n\n") : "";

async function askLanguage(db: SupabaseClient, conv: Conv, waId: string, s: Settings) {
  await sendButtons(db, conv, waId,
    (s.test_mode ? "Versión de prueba · Trial version\n\n" : "") +
    "¿En qué idioma prefieres que te atendamos?\n\nWhich language do you prefer?",
    [{ id: "bot:lang:es", title: "Español" }, { id: "bot:lang:en", title: "English" }]);
}

async function askLocation(db: SupabaseClient, conv: Conv, waId: string, lang: Lang) {
  await sendButtons(db, conv, waId, L(lang,
    "¿Sobre cuál de nuestras sedes quieres consultar?\n\n📍 *Piel Spa Manhattan*: 481 8th Ave, Nueva York (frente a Penn Station)\n📍 *Divine Bliss Studio*: North Brunswick, NJ",
    "Which of our locations are you asking about?\n\n📍 *Piel Spa Manhattan*: 481 8th Ave, New York (across from Penn Station)\n📍 *Divine Bliss Studio*: North Brunswick, NJ"),
    [{ id: "bot:loc:piel_spa", title: "Piel Spa Manhattan" }, { id: "bot:loc:divine_bliss", title: "Divine Bliss NJ" }]);
}

// ---------- Piel Spa Manhattan ----------
function back(lang: Lang): Btn[] {
  return [
    { id: "bot:book", title: L(lang, "Agendar cita", "Book appointment") },
    { id: "bot:menu", title: L(lang, "Ver opciones", "See options") },
    { id: "bot:human", title: L(lang, "Hablar con alguien", "Talk to someone") },
  ];
}

async function welcome(db: SupabaseClient, conv: Conv, waId: string, s: Settings, lang: Lang) {
  const name = await firstName(db, conv);
  const hello = name
    ? L(lang, `¡Hola ${name}! 💕 Qué gusto saludarte de nuevo. Soy el asistente virtual de Piel Spa Manhattan.`,
      `Hi ${name}! 💕 So nice to hear from you again. I'm Piel Spa Manhattan's virtual assistant.`)
    : L(lang, "¡Bienvenida/o a Piel Spa Manhattan! 💕 Soy el asistente virtual y te ayudo con servicios, precios y citas.",
      "Welcome to Piel Spa Manhattan! 💕 I'm the virtual assistant and can help with services, prices and appointments.");
  const promo = promoFor(s, lang) ? `\n\n${promoFor(s, lang)}` : "";
  const body = `${trialNote(s, lang)}${hello}${promo}\n\n` + L(lang,
    "¿Qué estás buscando? Escríbelo con tus palabras o toca *Ver opciones*. Puedes cambiar de idioma o hablar con el equipo desde el menú.",
    "What are you looking for? Type it in your own words or tap *See options*. You can change the language or talk to our team from the menu.");
  await mainMenu(db, conv, waId, lang, body);
  await saveConv(db, conv, { bot_greeted_at: new Date().toISOString() });
}

async function mainMenu(db: SupabaseClient, conv: Conv, waId: string, lang: Lang, body?: string) {
  if (conv.bot_location === "divine_bliss") {
    await setState(db, conv, null);
    await sendButtons(db, conv, waId, body ?? L(lang, "¿Cómo podemos ayudarte en Divine Bliss NJ?", "How can we help at Divine Bliss NJ?"), [
      { id: "bot:products", title: L(lang, "Ver skincare", "Shop skincare") },
      { id: "bot:human:divine_bliss", title: L(lang, "Hablar con alguien", "Talk to someone") },
      { id: "bot:lang:choose", title: L(lang, "Cambiar idioma", "Change language") },
    ]);
    return;
  }
  const rows: Row[] = [
    { id: "bot:question", title: L(lang, "Escribir mi consulta", "Type a question"), description: L(lang, "Busca en nuestro menú con tus palabras", "Search our menu in your own words") },
    { id: "bot:services", title: L(lang, "Servicios y precios", "Services & prices"), description: L(lang, "Faciales, peelings, inyectables y más", "Facials, peels, injectables and more") },
    { id: "bot:products", title: L(lang, "Productos de skincare", "Skincare products"), description: L(lang, "Busca por nombre o necesidad", "Browse by name or concern") },
    { id: "bot:book", title: L(lang, "Agendar cita", "Book appointment"), description: L(lang, "Elige día y hora disponibles", "Pick an available day and time") },
    { id: "bot:human", title: L(lang, "Hablar con alguien", "Talk to someone"), description: L(lang, "Te atiende una persona del equipo", "A team member will help you") },
  ];
  if (conv.patient_id) rows.push({ id: "bot:mine", title: L(lang, "Mis citas", "My appointments"), description: L(lang, "Ver o cambiar tu cita", "See or change your appointment") });
  rows.push({ id: "bot:info", title: L(lang, "Ubicación y horario", "Location & hours"), description: L(lang, "481 8th Ave, frente a Penn Station", "481 8th Ave, across from Penn Station") });
  rows.push({ id: "bot:loc:divine_bliss", title: "Divine Bliss (NJ)", description: L(lang, "Consultas sobre nuestra sede de New Jersey", "Questions about our New Jersey location") });
  rows.push({ id: "bot:lang:choose", title: L(lang, "Cambiar idioma", "Change language"), description: "Español / English" });
  await setState(db, conv, null);
  await sendList(db, conv, waId, body ?? L(lang, "¿En qué más te puedo ayudar?", "Anything else I can help with?"), L(lang, "Ver opciones", "See options"), rows, lang);
}

type Service = {
  code: string; name: string; category: string; unit: string; status: string; sale_price: number | null; unit_price: number | null;
  promo_price: number | null; bot_description: string | null; bot_price_mode: string | null; bot_name_en: string | null; bot_description_en: string | null;
};
async function botServices(db: SupabaseClient): Promise<{ categories: string[]; byCat: Record<string, Service[]> }> {
  const { data } = await db.from("sale_services")
    .select("code, name, category, unit, status, sale_price, unit_price, promo_price, bot_description, bot_price_mode, bot_name_en, bot_description_en, sort_order")
    .eq("active", true).eq("bot_visible", true).in("status", ["available", "assessment", "soon"])
    .order("sort_order").order("name");
  const byCat: Record<string, Service[]> = {};
  (data || []).forEach((s: Service) => { (byCat[s.category] = byCat[s.category] || []).push(s); });
  return { categories: Object.keys(byCat), byCat };
}
const isConsult = (category: string) => norm(category) === "consulta";
const money = (n: number) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;

function availableProducts(db: SupabaseClient, location: Loc | null) {
  return db.from("sale_products").select("id, catalog_id, brand, name, size, sale_price, stock_qty, sales_taxable, skincare_products!inner(id)")
    .eq("skincare_products.active", true).eq("skincare_products.is_prescription", false)
    .eq("location", location || "piel_spa").eq("active", true).eq("bot_visible", true).gt("stock_qty", 0).gt("sale_price", 0)
    .or(`expires_on.is.null,expires_on.gte.${clinicDate(0)}`);
}
const productPlace = (conv: Conv) => conv.bot_location === "divine_bliss" ? "Divine Bliss NJ" : "Piel Spa Manhattan";
const productPrice = (value: number, conv: Conv, s: Settings) =>
  conv.bot_location === "piel_spa" ? Math.round(Math.round(Number(value) * 100) * (10000 - Math.round(s.product_discount * 100)) / 10000) / 100 : Number(value);

const PRODUCT_CONCERNS: Record<string, string[]> = {
  dehydration: ["hidratacion", "deshidratacion", "hydration", "dehydration"],
  spots: ["manchas", "dark spots", "uneven tone"],
  melasma: ["melasma"],
  acne: ["acne", "brotes", "breakouts"],
  shine: ["brillo", "grasa", "oily", "shine"],
  texture: ["textura", "poros", "texture", "pores"],
  wrinkles: ["arrugas", "lineas", "wrinkles", "fine lines"],
  redness: ["rojeces", "enrojecimiento", "redness"],
};
const PRODUCT_STEPS: Record<string, string[]> = {
  spf: ["protector solar", "sunscreen", "spf", "bloqueador"],
  cleanser: ["limpiador", "limpieza", "cleanser"],
  moisturizer: ["crema", "moisturizer", "hidratante"],
  serum: ["serum", "suero"],
};
const PRODUCT_SKIN_TYPES: Record<string, string[]> = {
  oily: ["piel grasa", "oily skin"], dry: ["piel seca", "dry skin"],
  combination: ["piel mixta", "combination skin"], normal: ["piel normal", "normal skin"],
};

function productTags(t: string, tags: Record<string, string[]>) {
  return Object.keys(tags).filter((key) => hasWord(t, tags[key]));
}

async function searchProducts(db: SupabaseClient, conv: Conv, waId: string, lang: Lang, t: string, s: Settings) {
  const [catalogResult, stockResult] = await Promise.all([
    db.from("skincare_products").select("id, name, brand, step, concerns, skin_types, is_prescription").eq("active", true),
    availableProducts(db, conv.bot_location).order("brand").order("name"),
  ]);
  if (catalogResult.error) throw catalogResult.error;
  if (stockResult.error) throw stockResult.error;
  const catalog = catalogResult.data ?? [];
  const target = catalog.filter((p) => norm(p.name).length >= 4 && t.includes(norm(p.name)))
    .sort((a, b) => norm(b.name).length - norm(a.name).length)[0];
  const concerns = productTags(t, PRODUCT_CONCERNS);
  const steps = productTags(t, PRODUCT_STEPS);
  const types = productTags(t, PRODUCT_SKIN_TYPES);
  const metadata = new Map(catalog.map((p) => [p.id, p]));
  const stock = stockResult.data ?? [];
  const exact = target ? stock.filter((p) => p.catalog_id === target.id) : [];
  const desiredConcerns = concerns.length ? concerns : target?.concerns ?? [];
  const matches = stock.filter((p) => {
    const info = metadata.get(p.catalog_id);
    if (!info || info.is_prescription) return false;
    const requestedSteps = target ? [target.step] : steps;
    if (requestedSteps.length && !requestedSteps.includes(info.step)) return false;
    if (desiredConcerns.length && !desiredConcerns.some((need: string) => info.concerns.includes(need))) return false;
    if (types.length && !types.some((type) => info.skin_types.includes(type))) return false;
    return desiredConcerns.length || (!target && steps.length);
  });
  const products = exact.length ? exact : target?.is_prescription ? [] : matches;
  const rows: Row[] = products.slice(0, 7).map((p) => ({
    id: `bot:product:${p.id}`, title: p.name,
    description: [p.brand, p.size, money(productPrice(p.sale_price, conv, s))].filter(Boolean).join(" · "),
  }));
  rows.push({ id: "bot:products:0", title: L(lang, "Ver disponibles", "See what's in stock") },
    { id: "bot:book", title: L(lang, "Pedir valoración", "Book an assessment") },
    { id: "bot:human", title: L(lang, "Hablar con alguien", "Talk to someone") });
  await setState(db, conv, "product_search");
  const body = exact.length ? L(lang, "Encontré este producto en stock.", "I found this product in stock.")
    : products.length ? L(lang, "Estas son las opciones disponibles que coinciden con tu búsqueda.", "These in-stock options match your search.")
    : L(lang, "No encontré una opción disponible que coincida. Puedes explorar el catálogo o pedir ayuda al equipo.",
      "I couldn't find an available match. Browse the catalog or ask our team for help.");
  await sendList(db, conv, waId, body + (!types.length && !exact.length
    ? L(lang, " Si no sabes tu tipo de piel, puedes pedir una valoración.", " If you don't know your skin type, you can book an assessment.") : ""),
  L(lang, "Ver opciones", "See options"), rows, lang);
}

async function productsHome(db: SupabaseClient, conv: Conv, waId: string, lang: Lang) {
  await setState(db, conv, "product_search");
  await sendButtons(db, conv, waId, L(lang,
    "Dime qué producto buscas o qué quieres atender, por ejemplo hidratación o manchas. Si sabes tu tipo de piel, inclúyelo. Si tienes dudas, podemos ayudarte con una valoración.",
    "Tell me the product name or what you're looking for, such as hydration or dark spots. Include your skin type if you know it. If you're unsure, we can help with an assessment."), [
    { id: "bot:products:0", title: L(lang, "Ver disponibles", "See what's in stock") },
    { id: "bot:book", title: L(lang, "Pedir valoración", "Book an assessment") },
    { id: "bot:human", title: L(lang, "Hablar con alguien", "Talk to someone") },
  ]);
}

async function productsMenu(db: SupabaseClient, conv: Conv, waId: string, lang: Lang, s: Settings, page = 0) {
  await setState(db, conv, null);
  const offset = page * 7;
  const { data, error } = await availableProducts(db, conv.bot_location).order("brand").order("name").order("id").range(offset, offset + 7);
  if (error) throw error;
  const items = data ?? [];
  const rows: Row[] = items.slice(0, 7).map((p) => ({
    id: `bot:product:${p.id}`, title: p.name,
    description: [p.brand, p.size, money(productPrice(p.sale_price, conv, s)), L(lang, `${p.stock_qty} disponibles`, `${p.stock_qty} in stock`)].filter(Boolean).join(" · "),
  }));
  if (page > 0) rows.push({ id: `bot:products:${page - 1}`, title: L(lang, "Anterior", "Previous") });
  if (items.length > 7) rows.push({ id: `bot:products:${page + 1}`, title: L(lang, "Más productos", "More products") });
  rows.push({ id: "bot:menu", title: L(lang, "Menú principal", "Main menu") });
  await sendList(db, conv, waId, items.length
    ? L(lang, `Productos disponibles en ${productPlace(conv)}. Elige uno para pedirlo.`, `Products available at ${productPlace(conv)}. Choose one to request it.`)
    : L(lang, "No hay productos disponibles en esta página. Puedes volver al menú y hablar con el equipo.",
      "There are no products available on this page. Go back to the menu to talk to our team."),
    L(lang, "Ver opciones", "See options"), rows, lang);
}

const productId = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
async function getProduct(db: SupabaseClient, id: string, location: Loc | null) {
  if (!productId(id)) return null;
  const { data, error } = await availableProducts(db, location).eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function productDetail(db: SupabaseClient, conv: Conv, waId: string, id: string, lang: Lang, s: Settings) {
  const p = await getProduct(db, id, conv.bot_location);
  if (!p) return productsMenu(db, conv, waId, lang, s);
  await setState(db, conv, `product_quantity:${p.id}`);
  const name = [p.brand, p.name, p.size].filter(Boolean).join(" ").slice(0, 160);
  const price = productPrice(p.sale_price, conv, s);
  const promo = price < Number(p.sale_price) ? ` · Black Friday −${s.product_discount}%` : "";
  await sendButtons(db, conv, waId, `*${name}* · ${money(price)}${p.sales_taxable ? L(lang, " + impuesto", " + tax") : ""}${promo}\n\n` +
    L(lang, `Hay ${p.stock_qty} disponibles. Escribe cuántos quieres y nuestro equipo confirmará el pedido contigo.`,
      `${p.stock_qty} in stock. Type how many you'd like and our team will confirm your order.`), [
    { id: "bot:products", title: L(lang, "Ver otros productos", "See more products") },
    { id: "bot:human", title: L(lang, "Hablar con alguien", "Talk to someone") },
  ]);
}

// "por unidad", "por vial", "(2 sesiones)"; nothing for a plain session.
const UNIT_EN: [RegExp, string][] = [[/unidad(es)?/g, "unit"], [/jeringa/g, "syringe"], [/sesiones/g, "sessions"], [/sesi[oó]n/g, "session"], [/protocolo/g, "protocol"]];
function unitText(unit: string, lang: Lang): string {
  let u = String(unit || "").trim().toLowerCase();
  if (!u || ["sesión", "sesion", "consulta", "categoría"].includes(u)) return "";
  if (lang === "en") UNIT_EN.forEach(([re, en]) => { u = u.replace(re, en); });
  return /^\d/.test(u) ? ` (${u})` : L(lang, ` por ${u}`, ` per ${u}`);
}
// bot_price_mode: exact = the price · from = "desde" · consult = no price, it depends on the consultation.
function priceLine(s: Service, lang: Lang): string {
  const name = lang === "en" ? (s.bot_name_en || s.name) : s.name;
  const desc = lang === "en" ? (s.bot_description_en || "") : (s.bot_description || "");
  if (s.status === "soon") return `• *${name}*: ${L(lang, "próximamente", "coming soon")}`;
  const base = s.unit_price ?? s.sale_price;
  const mode = s.bot_price_mode || "exact";
  const per = unitText(s.unit, lang);
  const from = mode === "from" ? L(lang, "desde ", "from ") : "";
  let price = "";
  if (mode === "consult" || base == null) price = L(lang, "precio según tu consulta", "price depends on your consultation");
  else if (s.promo_price != null && s.promo_price < base) {
    price = L(lang, `${from}${money(s.promo_price)}${per} en promoción (regular ${from}${money(base)})`,
      `${from}${money(s.promo_price)}${per} on promotion (regular ${from}${money(base)})`);
  } else price = `${from}${money(base)}${per}`;
  return `• *${name}*: ${price}${desc ? `\n  ${desc}` : ""}`;
}

// First: what the person wants to treat (categories are concerns). The
// consultation is not a concern; its price is shown with every answer.
async function servicesMenu(db: SupabaseClient, conv: Conv, waId: string, s: Settings, lang: Lang) {
  const { categories } = await botServices(db);
  if (!categories.filter((c) => !isConsult(c)).length) {
    await sendButtons(db, conv, waId, L(lang,
      "Con gusto te cuento sobre nuestros servicios y precios. 😊 Nuestro equipo te los comparte personalmente según lo que buscas.",
      "Happy to tell you about our services and prices. 😊 Our team will share them with you based on what you're looking for."), [
      { id: "bot:human:precios", title: L(lang, "Pedir precios", "Ask for prices") },
      { id: "bot:book", title: L(lang, "Agendar cita", "Book appointment") },
      { id: "bot:menu", title: L(lang, "Ver opciones", "See options") },
    ]);
    return;
  }
  const rows: Row[] = categories.map((c, i) => ({ id: `bot:cat:${i}`, title: catName(c, lang) }))
    .filter((_, i) => !isConsult(categories[i])).slice(0, 9);
  rows.push({ id: "bot:human:servicios", title: L(lang, "No estoy seguro/a", "Not sure"), description: L(lang, "Cuéntale a nuestro equipo qué buscas", "Tell our team what you're looking for") });
  const promo = promoFor(s, lang) ? `${promoFor(s, lang)}\n\n` : "";
  await sendList(db, conv, waId, promo + L(lang,
    "Para recomendarte lo mejor, cuéntame: ¿qué te gustaría tratar o mejorar?",
    "To recommend the best option, tell me: what would you like to treat or improve?"), L(lang, "Elegir", "Choose"), rows, lang);
}

async function categoryDetail(db: SupabaseClient, conv: Conv, waId: string, index: number, s: Settings, lang: Lang) {
  const { categories, byCat } = await botServices(db);
  const cat = categories[index];
  if (!cat || isConsult(cat)) return servicesMenu(db, conv, waId, s, lang);
  const lines = byCat[cat].map((x) => priceLine(x, lang)).join("\n");
  const consult = categories.filter(isConsult).flatMap((c) => byCat[c]).map((x) => priceLine(x, lang)).join("\n");
  const text = L(lang, `Para *${cat.toLowerCase()}* te podemos ofrecer:`, `For *${catName(cat, lang).toLowerCase()}* we offer:`) + `\n${lines}` +
    (consult ? `\n\n${L(lang, "Si no sabes cuál elegir, empieza con una valoración:", "Not sure which one? Start with an assessment:")}\n${consult}` : "") +
    `\n\n${L(lang, "En tu primera visita revisamos tu piel para confirmar el tratamiento ideal para ti.",
      "On your first visit we check your skin to confirm the ideal treatment for you.")}`;
  const buttons: Btn[] = [
    { id: "bot:book", title: L(lang, "Agendar cita", "Book appointment") },
    { id: "bot:services", title: L(lang, "Tratar otra cosa", "Something else") },
    { id: "bot:human", title: L(lang, "Hablar con alguien", "Talk to someone") },
  ];
  // Button messages allow 1024 characters: longer lists go as text first.
  if (text.length <= 1024) {
    await sendButtons(db, conv, waId, text, buttons);
  } else {
    await sendText(db, conv, waId, text.slice(0, 4000));
    await sendButtons(db, conv, waId, L(lang, "¿Qué te gustaría hacer?", "What would you like to do?"), buttons);
  }
}

async function routeQuestion(db: SupabaseClient, conv: Conv, waId: string, lang: Lang, s: Settings, body: string): Promise<boolean> {
  const { categories, byCat } = await botServices(db);
  const services = categories.flatMap((category) => byCat[category]);
  const t = norm(body);
  const direct = services.find((service) => [service.name, service.bot_name_en].some((name) => name && norm(name).length > 3 && hasWord(t, [norm(name)])));
  let intent = direct ? `service_${services.indexOf(direct)}` : "unknown";
  if (!direct && s.test_mode && s.test_phones.includes(waId)) {
    const choices = Object.fromEntries([
      ...categories.map((category, index) => [`category_${index}`, `${category} / ${catName(category, "en")}`]),
      ...services.slice(0, 60).map((service, index) => [`service_${index}`, [service.name, service.bot_name_en].filter(Boolean).join(" / ")]),
    ]);
    intent = await matchMenuIntent(body, choices);
  }
  const service = /^service_\d+$/.test(intent) ? services[Number(intent.split("_")[1])] : undefined;
  if (service) {
    await sendButtons(db, conv, waId, priceLine(service, lang).slice(0, 1000), back(lang));
    return true;
  }
  const category = /^category_\d+$/.test(intent) ? Number(intent.split("_")[1]) : -1;
  if (category >= 0 && category < categories.length) {
    if (isConsult(categories[category])) {
      await sendButtons(db, conv, waId, priceLine(byCat[categories[category]][0], lang).slice(0, 1000), back(lang));
    } else await categoryDetail(db, conv, waId, category, s, lang);
    return true;
  }
  switch (intent) {
    case "products": await searchProducts(db, conv, waId, lang, t, s); return true;
    case "services": await servicesMenu(db, conv, waId, s, lang); return true;
    case "book": await book(db, conv, waId, lang); return true;
    case "info": await info(db, conv, waId, s, lang); return true;
    case "mine": await mine(db, conv, waId, lang); return true;
    case "human": await handOff(db, conv, waId, "question", s, lang, body); return true;
    default: return false;
  }
}

async function upcoming(db: SupabaseClient, conv: Conv) {
  if (!conv.patient_id) return [];
  const { data } = await db.from("appointments")
    .select("id, appointment_date, appointment_time, status, location")
    .eq("patient_id", conv.patient_id).gte("appointment_date", clinicDate(0)).neq("status", "cancelled")
    .order("appointment_date").order("appointment_time").limit(3);
  return data || [];
}
const timeOf = (a: Json) => formatTime12h(String(a.appointment_time).slice(0, 5));

async function book(db: SupabaseClient, conv: Conv, waId: string, lang: Lang) {
  const next = (await upcoming(db, conv))[0];
  const already = next
    ? L(lang, `Ya tienes una cita el ${dayText(next.appointment_date, lang)} a las ${timeOf(next)}. Si quieres otra, puedes`,
      `You already have an appointment on ${dayText(next.appointment_date, lang)} at ${timeOf(next)}. If you'd like another one, you can`)
    : L(lang, "Puedes", "You can");
  const body = `${already} ${L(lang,
    "reservar en un minuto aquí, eligiendo el día y la hora disponibles:",
    "book in a minute here, choosing an available day and time:")}\n${BOOKING_URL}\n\n${L(lang,
    "Recibes la confirmación por WhatsApp. Si prefieres, nuestro equipo te agenda por aquí.",
    "You'll get the confirmation on WhatsApp. If you prefer, our team can book it for you here.")}`;
  const buttons: Btn[] = [{ id: "bot:human:agendar", title: L(lang, "Que me agenden", "Book it for me") }];
  if (next) buttons.push({ id: `bot:resched:${next.id}`, title: L(lang, "Cambiar mi cita", "Change my appt") });
  buttons.push({ id: "bot:menu", title: L(lang, "Ver opciones", "See options") });
  await sendButtons(db, conv, waId, body, buttons);
}

async function mine(db: SupabaseClient, conv: Conv, waId: string, lang: Lang) {
  const list = await upcoming(db, conv);
  if (!list.length) {
    await sendButtons(db, conv, waId, L(lang, "No vemos citas próximas a tu nombre. ¿Quieres agendar una?",
      "We don't see any upcoming appointments under your name. Would you like to book one?"), back(lang));
    return;
  }
  const places = await clinicPlaces(db);
  const a = list[0];
  const more = list.length - 1;
  const body = L(lang, `Tu próxima cita es el ${dayText(a.appointment_date, lang)} a las ${timeOf(a)} en ${placeFor(places, a.location)}.`,
    `Your next appointment is on ${dayText(a.appointment_date, lang)} at ${timeOf(a)} at ${placeFor(places, a.location)}.`) +
    (more ? `\n\n${L(lang, `También tienes ${more} cita${more > 1 ? "s" : ""} más después.`, `You also have ${more} more appointment${more > 1 ? "s" : ""} after that.`)}` : "") +
    `\n\n${L(lang, "Llega 15 minutos antes, con la cara limpia y el menor maquillaje posible.",
      "Please arrive 15 minutes early, with a clean face and as little makeup as possible.")}`;
  await sendButtons(db, conv, waId, body, [
    { id: `bot:resched:${a.id}`, title: L(lang, "Cambiar mi cita", "Change my appt") },
    { id: "bot:menu", title: L(lang, "Ver opciones", "See options") },
    { id: "bot:human", title: L(lang, "Hablar con alguien", "Talk to someone") },
  ]);
}

async function info(db: SupabaseClient, conv: Conv, waId: string, s: Settings, lang: Lang) {
  await send(db, conv, waId, {
    type: "location",
    location: { latitude: 40.75285, longitude: -73.99358, name: "Piel Spa", address: "481 8th Ave, Suite 1221, New York, NY 10001" },
  }, `📍 Piel Spa · 481 8th Ave, Suite 1221 · ${MAPS_URL}`);
  const body = L(lang,
    "Estamos dentro de *The New Yorker Hotel*, 481 8th Ave, Suite 1221 (calle 34 Oeste), frente a Penn Station. 🚇\n\nAtendemos solo con cita. Hay estacionamientos públicos a 1 o 2 cuadras.",
    "We're inside *The New Yorker Hotel*, 481 8th Ave, Suite 1221 (W 34th St), across from Penn Station. 🚇\n\nBy appointment only. There are public parking garages 1–2 blocks away.") +
    `\n\n${L(lang, "Nuestro equipo responde WhatsApp", "Our team answers WhatsApp")} ${hoursText(s.human_hours, lang)}.`;
  await sendButtons(db, conv, waId, body, back(lang));
}

// ---------- hand-off to a person ----------
const REASONS: Record<string, string> = {
  human: "Pide hablar con alguien", question: "Tiene una pregunta", medical: "Pregunta de salud", photo: "Envió una foto",
  after_care: "⚠️ Molestia después de un tratamiento", urgent: "🚨 Posible urgencia", complaint: "Queja o reclamo",
  payment: "Pagos o reembolsos", audio: "Envió un audio", precios: "Pide precios", agendar: "Quiere que le agenden",
  servicios: "Pregunta sobre servicios", unknown: "Mensaje que el asistente no entendió", divine_bliss: "Divine Bliss Studio",
  product_order: "🛍️ Solicitud de apartado", product_contact: "🛍️ Consulta de compra",
};

export async function handOff(db: SupabaseClient, conv: Conv, waId: string, reason: string, s: Settings, lang: Lang, preview = "") {
  const open = withinHumanHours(s.human_hours);
  const later = L(lang,
    `En este momento estamos fuera del horario de atención. Nuestro equipo responde ${hoursText(s.human_hours, lang)} y te escribe apenas abramos. 💕`,
    `We're currently outside our service hours. Our team answers ${hoursText(s.human_hours, lang)} and will write to you as soon as we open. 💕`);
  let first: string;
  if (reason === "divine_bliss") {
    const name = await firstName(db, conv);
    const hello = name ? L(lang, `¡Hola ${name}! 💕 `, `Hi ${name}! 💕 `) : "";
    first = hello + (open
      ? L(lang, "Gracias por escribir a *Divine Bliss Studio* (North Brunswick, NJ). Te comunico con nuestro equipo, que te escribe por aquí en breve.",
        "Thanks for contacting *Divine Bliss Studio* (North Brunswick, NJ). I'm connecting you with our team, who will write to you here shortly.")
      : L(lang, "Gracias por escribir a *Divine Bliss Studio* (North Brunswick, NJ). Le dejé tu mensaje a nuestro equipo.",
        "Thanks for contacting *Divine Bliss Studio* (North Brunswick, NJ). I've left your message for our team."));
  } else {
    const lead: Record<string, [string, string]> = {
      urgent: ["Si tienes dolor fuerte, la piel se pone blanca o morada, te cuesta respirar o cambia tu vista, *llama al 911 o ve a urgencias ahora*. Ya avisamos a nuestro equipo médico con prioridad.",
        "If you have severe pain, your skin turns white or purple, you have trouble breathing or your vision changes, *call 911 or go to the ER now*. We've alerted our medical team as a priority."],
      after_care: ["Gracias por avisarnos. Ya le pasé tu mensaje a nuestro equipo médico con prioridad. Si el dolor es fuerte, la piel se pone blanca o morada o cambia tu vista, llama al 911 o ve a urgencias.",
        "Thanks for letting us know. I've passed your message to our medical team as a priority. If the pain is severe, your skin turns white or purple or your vision changes, call 911 or go to the ER."],
      medical: ["Esa pregunta es mejor que la responda nuestro equipo médico. Ya les avisé y te escriben por aquí.",
        "That question is best answered by our medical team. I've let them know and they'll write to you here."],
      photo: ["Gracias por la foto. Para recomendarte algo, nuestro equipo médico necesita revisarla; ya les avisé y te escriben por aquí. También podemos agendarte una valoración.",
        "Thanks for the photo. To recommend anything, our medical team needs to review it; I've let them know and they'll write to you here. We can also book you an assessment."],
      complaint: ["Lamento mucho lo que pasó. Le paso tu mensaje al equipo para que te responda personalmente.",
        "I'm very sorry about what happened. I'm passing your message to the team so they can answer you personally."],
      payment: ["Le paso tu consulta al equipo para que te ayude personalmente.", "I'm passing your question to the team so they can help you personally."],
      product_order: [`Envié tu solicitud al equipo: ${preview}. Te confirmarán disponibilidad y compra por aquí.`,
        `I sent your request to our team: ${preview}. They'll confirm availability and your purchase here.`],
      product_contact: ["Nuestro equipo te escribirá para ayudarte con la compra.", "Our team will message you to help with the purchase."],
      audio: ["Recibí tu audio. 🎧 Nuestro equipo lo escucha y te responde por aquí.", "I got your audio. 🎧 Our team will listen to it and reply here."],
      question: ["¡Gracias! Le pasé tu pregunta a nuestro equipo y te responden por aquí.", "Thanks! I passed your question to our team and they'll reply here."],
      unknown: ["Le pasé tu mensaje a nuestro equipo y te responden por aquí.", "I passed your message to our team and they'll reply here."],
    };
    const pair = lead[reason] ?? ["Claro, ya le avisé a nuestro equipo y te escriben por aquí en breve.", "Sure, I've let our team know and they'll write to you here shortly."];
    first = L(lang, pair[0], pair[1]);
  }
  const body = open ? `${first}${reason === "urgent" || reason === "divine_bliss" ? "" : " 😊"}` : `${first}\n\n${later}`;
  const now = new Date().toISOString();
  await saveConv(db, conv, { bot_active: false, needs_attention: true, handoff_reason: reason, handoff_at: now, human_since: now, bot_state: null });
  await sendText(db, conv, waId, body);

  const { data: p } = conv.patient_id
    ? await db.from("profiles").select("first_name, last_name").eq("id", conv.patient_id).maybeSingle()
    : { data: null };
  const name = `${p?.first_name || ""} ${p?.last_name || ""}`.trim() || conv.profile_name || `+${waId}`;
  const { data: unreadChats } = await db.from("wa_conversations").select("id, unread_count").gt("unread_count", 0);
  await sendPushToStaff(db, {
    title: `🙋 ${name} · ${REASONS[reason] ?? "Pide ayuda"}${lang === "en" ? " · 🇺🇸 inglés" : ""}`,
    body: (preview || "Abrir el chat").slice(0, 180),
    tag: conv.id,
    conversationId: conv.id,
    url: `/admin.html#mensajes&chat=${conv.id}`,
    badge: (unreadChats ?? []).reduce((sum, c) => sum + (c.unread_count || 0), 0),
    unreadConversationIds: (unreadChats ?? []).map((c) => c.id),
  }).catch((e) => console.error("handoff push:", (e as Error).message));
}

// ---------- entry point ----------
// Returns true when the bot took care of the message (no staff push needed).
export async function runBot(db: SupabaseClient, conversationId: string, waId: string, m: Json, body: string): Promise<boolean> {
  const { data: handles } = await db.rpc("wa_bot_handles", { p_conversation_id: conversationId });
  if (!handles) return false;
  const { data: conv } = await db.from("wa_conversations")
    .select("id, patient_id, profile_name, bot_state, bot_greeted_at, bot_lang, bot_location").eq("id", conversationId).single();
  if (!conv) return false;
  const s = await loadSettings(db);
  if (m.type === "reaction" || m.type === "sticker") return true;

  const tapped = m.type === "interactive" ? String(m.interactive?.list_reply?.id || m.interactive?.button_reply?.id || "") : "";
  const [, action, arg] = tapped.startsWith("bot:") ? tapped.split(":") : ["", "", ""];

  const t = norm(body);
  const manualLang = action === "lang" && (arg === "es" || arg === "en") ? arg
    : !tapped && /^(?:espanol|spanish)$/.test(t) ? "es"
    : !tapped && /^(?:ingles|english)$/.test(t) ? "en" : null;
  if (manualLang) await saveConv(db, conv, { bot_lang: manualLang, bot_state: null });
  if (!conv.bot_lang && conv.patient_id) await saveConv(db, conv, { bot_lang: detectLang(body) ?? "es" });
  const lang: Lang = conv.bot_lang ?? detectLang(body) ?? "es";

  // Location: chosen, saved, or (known patients) from their history.
  if (action === "loc" && (arg === "piel_spa" || arg === "divine_bliss")) await saveConv(db, conv, { bot_location: arg });
  if (!conv.bot_location && conv.patient_id) {
    const loc = await patientLocation(db, conv.patient_id);
    if (loc) await saveConv(db, conv, { bot_location: loc });
  }

  // Safety first, whatever the location or step: these always go to a person.
  if (!tapped && t) {
    if (has(t, URGENT)) { await handOff(db, conv, waId, "urgent", s, lang, body); return true; }
    if (has(t, AFTER_CARE)) { await handOff(db, conv, waId, "after_care", s, lang, body); return true; }
    if (has(t, MEDICAL)) { await handOff(db, conv, waId, "medical", s, lang, body); return true; }
  }

  // Unknown number: ask language, then location.
  if ((action === "lang" && arg === "choose") || (!tapped && /^(?:idioma|cambiar idioma|language|change language)$/.test(t)) || !conv.bot_lang) {
    await askLanguage(db, conv, waId, s);
    return true;
  }
  if (!conv.bot_location) { await askLocation(db, conv, waId, lang); return true; }

  const productAction = ["products", "product", "pickup"].includes(action) || (action === "human" && arg === "product_contact");
  const productMessage = (!tapped && has(t, PRODUCTS)) || conv.bot_state?.startsWith("product_");
  // New Jersey uses its own product inventory. Service inquiries go to staff.
  if (conv.bot_location === "divine_bliss" && !productAction && (Boolean(action) || !productMessage)) {
    if (action === "loc" || action === "menu" || manualLang || /^(?:menu|inicio|start)$/.test(t)) {
      await mainMenu(db, conv, waId, lang, trialNote(s, lang) + L(lang,
        "¿Qué estás buscando en Divine Bliss NJ?", "What are you looking for at Divine Bliss NJ?"));
      return true;
    }
    await handOff(db, conv, waId, "divine_bliss", s, lang, body || (tapped ? "Eligió Divine Bliss" : ""));
    return true;
  }

  // Piel Spa Manhattan. Just chose language/location → the greeting.
  if (manualLang || action === "loc") { await welcome(db, conv, waId, s, lang); return true; }

  switch (action) {
    case "menu": await setState(db, conv, null); await mainMenu(db, conv, waId, lang); return true;
    case "products":
      if (/^\d{1,4}$/.test(arg || "")) await productsMenu(db, conv, waId, lang, s, Number(arg));
      else await productsHome(db, conv, waId, lang);
      return true;
    case "product": await productDetail(db, conv, waId, arg || "", lang, s); return true;
    case "pickup": {
      const [, id, units, quoted] = conv.bot_state?.split(":") ?? [];
      const p = id && conv.bot_state?.startsWith("product_pickup:") ? await getProduct(db, id, conv.bot_location) : null;
      const quantity = Number(units);
      if (!p || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > p.stock_qty) await productsMenu(db, conv, waId, lang, s);
      else if (Number(quoted) !== productPrice(p.sale_price, conv, s)) await productDetail(db, conv, waId, p.id, lang, s);
      else {
        const name = [p.brand, p.name, p.size].filter(Boolean).join(" ").slice(0, 95);
        await handOff(db, conv, waId, "product_order", s, lang, `${quantity} × ${name} · ${money(Number(quoted))} c/u · ${productPlace(conv)}`);
      }
      return true;
    }
    case "services": await servicesMenu(db, conv, waId, s, lang); return true;
    case "cat": await categoryDetail(db, conv, waId, Number(arg) || 0, s, lang); return true;
    case "book": await book(db, conv, waId, lang); return true;
    case "mine": await mine(db, conv, waId, lang); return true;
    case "info": await info(db, conv, waId, s, lang); return true;
    case "question":
      await setState(db, conv, "search_menu");
      await sendText(db, conv, waId, L(lang, "¿Qué estás buscando? Escribe el nombre del tratamiento, producto o tema que quieres consultar.",
        "What are you looking for? Type the name of the treatment, product, or topic you have in mind."));
      return true;
    case "resched": {
      const outcome = await startReschedule(db, conv.id, waId, arg || null);
      if (outcome !== "done") await handOff(db, conv, waId, "agendar", s, lang, "Quiere cambiar su cita");
      return true;
    }
    case "human": await handOff(db, conv, waId, arg || "human", s, lang, body); return true;
  }

  // Photos, documents, audio, video.
  if (["image", "video", "document"].includes(m.type)) { await handOff(db, conv, waId, "photo", s, lang, body || "📷 Archivo"); return true; }
  if (m.type === "audio") { await handOff(db, conv, waId, "audio", s, lang, "🎤 Audio"); return true; }
  if (!t) { await welcome(db, conv, waId, s, lang); return true; }

  if (has(t, COMPLAINT)) { await handOff(db, conv, waId, "complaint", s, lang, body); return true; }
  if (has(t, PAYMENT)) { await handOff(db, conv, waId, "payment", s, lang, body); return true; }
  if (has(t, HUMAN)) { await handOff(db, conv, waId, "human", s, lang, body); return true; }

  // The patient was asked to write their question.
  if (conv.bot_state === "await_question") { await handOff(db, conv, waId, "question", s, lang, body); return true; }

  if (conv.bot_state?.startsWith("product_quantity:") && /^\d{1,8}(?: (?:unidades?|units?))?$/.test(t)) {
    const id = conv.bot_state.split(":")[1];
    const p = await getProduct(db, id, conv.bot_location);
    const quantity = Number(t.split(" ")[0]);
    if (!p) await productsMenu(db, conv, waId, lang, s);
    else if (quantity < 1 || quantity > p.stock_qty) {
      await sendText(db, conv, waId, L(lang, `Indica una cantidad de 1 a ${p.stock_qty}.`, `Enter a quantity from 1 to ${p.stock_qty}.`));
    } else {
      const price = productPrice(p.sale_price, conv, s);
      await setState(db, conv, `product_pickup:${p.id}:${quantity}:${price}`);
      await sendButtons(db, conv, waId, L(lang,
        `${quantity} × ${p.name} · ${money(price)} por unidad · ${productPlace(conv)}. El equipo confirma tu apartado.`,
        `${quantity} × ${p.name} · ${money(price)} each · ${productPlace(conv)}. Our team will confirm your pickup request.`), [
        { id: "bot:pickup", title: L(lang, "Pedir apartado", "Request pickup hold") },
        { id: "bot:human:product_contact", title: L(lang, "Que me escriban", "Contact me") },
        { id: "bot:products:0", title: L(lang, "Ver más productos", "See more products") },
      ]);
    }
    return true;
  }
  if (hasWord(t, ["menu", "inicio", "start"]) && t.length <= 6) {
    await setState(db, conv, null);
    await mainMenu(db, conv, waId, lang);
    return true;
  }
  if (conv.bot_state === "product_search") { await searchProducts(db, conv, waId, lang, t, s); return true; }
  if (has(t, PRODUCTS)) {
    if (productTags(t, PRODUCT_STEPS).length || productTags(t, PRODUCT_CONCERNS).length) await searchProducts(db, conv, waId, lang, t, s);
    else await productsHome(db, conv, waId, lang);
    return true;
  }
  if (conv.bot_location === "divine_bliss") { await handOff(db, conv, waId, "divine_bliss", s, lang, body); return true; }

  const simple = t.replace(/[¡!¿?.]+/g, "").trim();
  if (GREETING.includes(simple)) { await welcome(db, conv, waId, s, lang); return true; }
  if (THANKS.includes(simple)) {
    await sendText(db, conv, waId, L(lang, "¡Con gusto! 💕 Si necesitas algo más, aquí estoy. Escribe *menú* para ver las opciones.",
      "You're welcome! 💕 If you need anything else, I'm here. Type *menu* to see the options."));
    return true;
  }
  if (has(t, BOOK)) { await book(db, conv, waId, lang); return true; }
  if (has(t, INFO)) { await info(db, conv, waId, s, lang); return true; }
  if (conv.bot_state === "search_menu") await setState(db, conv, null);
  if (m.type === "text" && await routeQuestion(db, conv, waId, lang, s, body)) return true;
  if (has(t, SERVICES)) { await servicesMenu(db, conv, waId, s, lang); return true; }

  await handOff(db, conv, waId, "unknown", s, lang, body);
  return true;
}
