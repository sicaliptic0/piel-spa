import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CLINIC_TIME_ZONE, clinicDate, formatTime12h } from "../_shared/clinic.ts";
import { clinicPlaces, dayEs, placeFor } from "../_shared/appointmentText.ts";
import { sendWhatsAppMessage } from "../_shared/whatsapp.ts";
import { sendPushToStaff } from "../_shared/push.ts";
import { startReschedule } from "./reschedule.ts";

// WhatsApp assistant, phase 1: menus only, no AI.
//
// Answers only while wa_bot_handles() is true: the bot is on (wa_settings.bot_enabled)
// or the number is in wa_settings.bot_test_phones, and the chat is not with a
// person (wa_conversations.bot_active). When staff writes — from the panel or
// the phone — bot_active turns false and the bot stays quiet in that chat until
// "Resolver · reactivar IA".
//
// Everyone gets the same greeting (patients by first name), the promotion in
// wa_settings.promo_text, and four options: a question, services and prices,
// booking, talking to someone. Prices come only from sale_services rows marked
// bot_visible. Health questions, photos, complaints, payments, post-treatment
// problems and anything it doesn't understand go to staff ("Por responder")
// with a push saying why; outside human_hours the patient is told when the team
// answers. Row/button ids: bot:<action>[:<arg>].

// deno-lint-ignore no-explicit-any
type Json = any;

const BOOKING_URL = "https://piel-spa.com/agendar.html";
const MAPS_URL = "https://maps.app.goo.gl/?q=481+8th+Ave+Suite+1221+New+York+NY+10001";
const GREET_AGAIN_HOURS = 12;

type Settings = { promo_text: string; human_hours: { days: number[]; open: string; close: string } };
type Conv = { id: string; patient_id: string | null; profile_name: string | null; bot_state: string | null; bot_greeted_at: string | null };

// ---------- text matching ----------
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Stems match at the start of a word ("embaraz" → "embarazada", not "desembarazar"
// mid-word; "hi" never inside "chin"). Emojis match anywhere.
const has = (t: string, words: string[]) => words.some((w) =>
  /^[\p{L}\p{N}' ]+$/u.test(w) ? new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}`, "u").test(t) : t.includes(w));
// Whole words only (greetings, thanks: "ok" must not match "book").
const hasWord = (t: string, words: string[]) => words.some((w) =>
  /^[\p{L}\p{N}' ]+$/u.test(w) ? new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, "u").test(t) : t.includes(w));

const URGENT = ["no puedo respirar", "me falta el aire", "cant breathe", "can't breathe", "vision borrosa", "veo borroso", "perdi la vision",
  "no veo", "piel blanca", "se puso blanca", "se puso morada", "emergencia", "emergency", "911"];
const AFTER_CARE = ["hinchaz", "hinchad", "inflamad", "moreton", "morado", "hematoma", "me duele", "dolor", "ardor", "quemadura", "reaccion",
  "molestia", "swelling", "swollen", "bruise", "pain", "infecc", "infect", "fiebre", "fever"];
const MEDICAL = ["embaraz", "lactan", "amamant", "pregnan", "breastfeed", "medicament", "pastilla", "alergi", "allerg", "isotretino", "accutane",
  "roacutan", "anticoagul", "warfarin", "herpes", "diabet", "cancer", "quimio", "enfermedad", "autoinmun", "lupus", "tiroides", "presion alta",
  "marcapaso", "piel sensible", "rosacea", "dermatitis", "es seguro", "contraindic", "puedo hacerme", "me lo puedo hacer"];
const COMPLAINT = ["queja", "reclamo", "mala experiencia", "mal servicio", "no me gusto", "molesta", "complaint", "terrible", "estafa"];
const PAYMENT = ["reembolso", "devolucion", "refund", "me cobraron", "cobro", "factura", "pagar", "pago", "zelle", "tarjeta", "deposito"];
const HUMAN = ["humano", "persona", "alguien", "asesor", "agente", "operador", "llamar", "llamada", "hablar con", "human", "agent",
  "representative", "someone", "real person", "doctor", "doctora", "medico"];
const GREETING = ["hola", "buenas", "buenos dias", "buen dia", "saludos", "hi", "hello", "hey", "info", "informacion", "menu", "inicio", "start", "opciones"];
const THANKS = ["gracias", "muchas gracias", "thanks", "thank you", "ok", "okay", "perfecto", "listo", "genial", "excelente", "👍", "❤", "🙏", "super"];
const SERVICES = ["precio", "cuanto", "cuesta", "costo", "vale", "servicio", "tratamiento", "promo", "oferta", "descuento", "black friday",
  "botox", "toxina", "facial", "relleno", "labio", "peeling", "mancha", "acne", "microneedling", "microagujas", "sculptra", "endolaser",
  "papada", "depilacion", "laser", "price", "cost"];
const BOOK = ["cita", "agendar", "agenda", "reservar", "reserva", "turno", "disponib", "appointment", "book"];
const INFO = ["donde", "direccion", "ubicacion", "ubicados", "como llego", "estacionamiento", "parking", "horario", "abren", "address", "location", "hours"];

// ---------- settings, hours ----------
async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data } = await db.from("wa_settings").select("promo_text, human_hours").eq("id", 1).maybeSingle();
  return {
    promo_text: String(data?.promo_text ?? "").trim(),
    human_hours: data?.human_hours ?? { days: [1, 2, 3, 4, 5, 6], open: "09:00", close: "19:00" },
  };
}

function nowInClinic(): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TIME_ZONE, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), hhmm: `${get("hour")}:${get("minute")}` };
}
export function withinHumanHours(h: Settings["human_hours"]): boolean {
  const { weekday, hhmm } = nowInClinic();
  return (h.days || []).includes(weekday) && hhmm >= h.open && hhmm < h.close;
}
const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
function hoursText(h: Settings["human_hours"]): string {
  const d = [...(h.days || [])].sort();
  const consecutive = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const days = consecutive ? `de ${DAY_NAMES[d[0]]} a ${DAY_NAMES[d[d.length - 1]]}` : d.map((x) => DAY_NAMES[x]).join(", ");
  return `${days}, de ${formatTime12h(h.open)} a ${formatTime12h(h.close)}`;
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
function sendList(db: SupabaseClient, conv: Conv, waId: string, body: string, button: string, rows: Row[]) {
  const clean = rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) }));
  return send(db, conv, waId, {
    type: "interactive",
    interactive: { type: "list", body: { text: body }, action: { button: button.slice(0, 20), sections: [{ title: "Opciones", rows: clean }] } },
  }, [body, ...clean.map((r) => `• ${r.title}`)].join("\n"));
}

async function setState(db: SupabaseClient, conv: Conv, state: string | null) {
  conv.bot_state = state;
  await db.from("wa_conversations").update({ bot_state: state, bot_state_at: new Date().toISOString() }).eq("id", conv.id);
}

async function firstName(db: SupabaseClient, conv: Conv): Promise<string> {
  if (!conv.patient_id) return "";
  const { data } = await db.from("profiles").select("first_name").eq("id", conv.patient_id).maybeSingle();
  const n = String(data?.first_name || "").trim().split(/\s+/)[0] || "";
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : "";
}

// ---------- steps ----------
const BACK: Btn[] = [{ id: "bot:book", title: "Agendar cita" }, { id: "bot:menu", title: "Ver opciones" }, { id: "bot:human", title: "Hablar con alguien" }];

async function welcome(db: SupabaseClient, conv: Conv, waId: string, s: Settings) {
  const name = await firstName(db, conv);
  const hello = name
    ? `¡Hola ${name}! 💕 Qué gusto saludarte de nuevo. Soy el asistente virtual de Piel Spa.`
    : "¡Hola! 💕 Gracias por escribir a Piel Spa. Soy el asistente virtual y te ayudo con servicios, precios y citas.";
  const promo = s.promo_text ? `\n\n${s.promo_text}` : "";
  const body = `${hello}${promo}\n\n¿En qué te puedo ayudar? Toca *Ver opciones*. Si prefieres hablar con nuestro equipo, elige "Hablar con alguien".`;
  await mainMenu(db, conv, waId, body);
  await db.from("wa_conversations").update({ bot_greeted_at: new Date().toISOString() }).eq("id", conv.id);
}

async function mainMenu(db: SupabaseClient, conv: Conv, waId: string, body = "¿En qué más te puedo ayudar?") {
  const rows: Row[] = [
    { id: "bot:question", title: "Tengo una pregunta", description: "Escríbela y te responde nuestro equipo" },
    { id: "bot:services", title: "Servicios y precios", description: "Faciales, peelings, inyectables y más" },
    { id: "bot:book", title: "Agendar cita", description: "Elige día y hora disponibles" },
    { id: "bot:human", title: "Hablar con alguien", description: "Te atiende una persona del equipo" },
  ];
  if (conv.patient_id) rows.push({ id: "bot:mine", title: "Mis citas", description: "Ver, confirmar o cambiar tu cita" });
  rows.push({ id: "bot:info", title: "Ubicación y horario", description: "481 8th Ave, frente a Penn Station" });
  await setState(db, conv, null);
  await sendList(db, conv, waId, body, "Ver opciones", rows);
}

type Service = { code: string; name: string; category: string; unit: string; status: string; sale_price: number | null; unit_price: number | null; promo_price: number | null; bot_description: string | null; bot_price_mode: string | null };
async function botServices(db: SupabaseClient): Promise<{ categories: string[]; byCat: Record<string, Service[]> }> {
  const { data } = await db.from("sale_services")
    .select("code, name, category, unit, status, sale_price, unit_price, promo_price, bot_description, bot_price_mode, sort_order")
    .eq("active", true).eq("bot_visible", true).in("status", ["available", "assessment", "soon"])
    .order("sort_order").order("name");
  const byCat: Record<string, Service[]> = {};
  (data || []).forEach((s: Service) => { (byCat[s.category] = byCat[s.category] || []).push(s); });
  return { categories: Object.keys(byCat), byCat };
}
const money = (n: number) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;
// "por unidad", "por vial", "(2 sesiones)"; nothing for a plain session.
function unitText(unit: string): string {
  const u = String(unit || "").trim().toLowerCase();
  if (!u || ["sesión", "sesion", "consulta", "categoría"].includes(u)) return "";
  return /^\d/.test(u) ? ` (${u})` : ` por ${u}`;
}
// bot_price_mode: exact = the price · from = "desde" · consult = no price, it depends on the consultation.
function priceLine(s: Service): string {
  if (s.status === "soon") return `• *${s.name}*: próximamente`;
  const base = s.unit_price ?? s.sale_price;
  const mode = s.bot_price_mode || "exact";
  const per = unitText(s.unit);
  const from = mode === "from" ? "desde " : "";
  let price = "";
  if (mode === "consult" || base == null) price = "precio según tu consulta";
  else if (s.promo_price != null && s.promo_price < base) price = `${from}${money(s.promo_price)}${per} en promoción (regular ${from}${money(base)})`;
  else price = `${from}${money(base)}${per}`;
  const note = s.status === "assessment" ? " · requiere valoración" : "";
  return `• *${s.name}*: ${price}${note}${s.bot_description ? `\n  ${s.bot_description}` : ""}`;
}

// First: what the person wants to treat (categories are concerns: "Manchas y
// melasma", "Flacidez"…). The consultation is not a concern; its price is shown
// with every answer.
async function servicesMenu(db: SupabaseClient, conv: Conv, waId: string, s: Settings) {
  const { categories } = await botServices(db);
  if (!categories.filter((c) => !isConsult(c)).length) {
    await sendButtons(db, conv, waId,
      "Con gusto te cuento sobre nuestros servicios y precios. 😊 Nuestro equipo te los comparte personalmente según lo que buscas.", [
        { id: "bot:human:precios", title: "Pedir precios" }, { id: "bot:book", title: "Agendar cita" }, { id: "bot:menu", title: "Ver opciones" },
      ]);
    return;
  }
  const rows: Row[] = categories.map((c, i) => ({ id: `bot:cat:${i}`, title: c })).filter((r) => !isConsult(r.title)).slice(0, 9);
  rows.push({ id: "bot:human:servicios", title: "No estoy seguro/a", description: "Cuéntale a nuestro equipo qué buscas" });
  const promo = s.promo_text ? `${s.promo_text}\n\n` : "";
  await sendList(db, conv, waId, `${promo}Para recomendarte lo mejor, cuéntame: ¿qué te gustaría tratar o mejorar?`, "Elegir", rows);
}

const isConsult = (category: string) => norm(category) === "consulta";

async function categoryDetail(db: SupabaseClient, conv: Conv, waId: string, index: number, s: Settings) {
  const { categories, byCat } = await botServices(db);
  const cat = categories[index];
  if (!cat || isConsult(cat)) return servicesMenu(db, conv, waId, s);
  const lines = byCat[cat].map(priceLine).join("\n");
  const consult = categories.filter(isConsult).flatMap((c) => byCat[c]).map(priceLine).join("\n");
  const text = `Para *${cat.toLowerCase()}* te podemos ofrecer:\n${lines}` +
    (consult ? `\n\nSi no sabes cuál elegir, empieza con una valoración:\n${consult}` : "") +
    "\n\nEn tu primera visita revisamos tu piel para confirmar el tratamiento ideal para ti.";
  const buttons: Btn[] = [{ id: "bot:book", title: "Agendar cita" }, { id: "bot:services", title: "Tratar otra cosa" }, { id: "bot:human", title: "Hablar con alguien" }];
  // Button messages allow 1024 characters: longer lists go as text first.
  if (text.length <= 1024) {
    await sendButtons(db, conv, waId, text, buttons);
  } else {
    await sendText(db, conv, waId, text.slice(0, 4000));
    await sendButtons(db, conv, waId, "¿Qué te gustaría hacer?", buttons);
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

async function book(db: SupabaseClient, conv: Conv, waId: string) {
  const next = (await upcoming(db, conv))[0];
  const already = next
    ? `Ya tienes una cita el ${dayEs(next.appointment_date)} a las ${formatTime12h(String(next.appointment_time).slice(0, 5))}. Si quieres otra, `
    : "";
  const body = `${already}${already ? "puedes" : "Puedes"} reservar en un minuto aquí, eligiendo el día y la hora disponibles:\n${BOOKING_URL}\n\nRecibes la confirmación por WhatsApp. Si prefieres, nuestro equipo te agenda por aquí.`;
  const buttons: Btn[] = [{ id: "bot:human:agendar", title: "Que me agenden" }];
  if (next) buttons.push({ id: `bot:resched:${next.id}`, title: "Cambiar mi cita" });
  buttons.push({ id: "bot:menu", title: "Ver opciones" });
  await sendButtons(db, conv, waId, body, buttons);
}

async function mine(db: SupabaseClient, conv: Conv, waId: string) {
  const list = await upcoming(db, conv);
  if (!list.length) {
    await sendButtons(db, conv, waId, "No vemos citas próximas a tu nombre. ¿Quieres agendar una?", [
      { id: "bot:book", title: "Agendar cita" }, { id: "bot:menu", title: "Ver opciones" }, { id: "bot:human", title: "Hablar con alguien" },
    ]);
    return;
  }
  const places = await clinicPlaces(db);
  const a = list[0];
  const body = `Tu próxima cita es el ${dayEs(a.appointment_date)} a las ${formatTime12h(String(a.appointment_time).slice(0, 5))} en ${placeFor(places, a.location)}.` +
    (list.length > 1 ? `\n\nTambién tienes ${list.length - 1} cita${list.length > 2 ? "s" : ""} más después.` : "") +
    "\n\nLlega 15 minutos antes, con la cara limpia y el menor maquillaje posible.";
  await sendButtons(db, conv, waId, body, [
    { id: `bot:resched:${a.id}`, title: "Cambiar mi cita" }, { id: "bot:menu", title: "Ver opciones" }, { id: "bot:human", title: "Hablar con alguien" },
  ]);
}

async function info(db: SupabaseClient, conv: Conv, waId: string, s: Settings) {
  await send(db, conv, waId, {
    type: "location",
    location: { latitude: 40.75285, longitude: -73.99358, name: "Piel Spa", address: "481 8th Ave, Suite 1221, New York, NY 10001" },
  }, `📍 Piel Spa · 481 8th Ave, Suite 1221 · ${MAPS_URL}`);
  const body = "Estamos dentro de *The New Yorker Hotel*, 481 8th Ave, Suite 1221 (calle 34 Oeste), frente a Penn Station. 🚇\n\n" +
    "Atendemos solo con cita. Hay estacionamientos públicos a 1 o 2 cuadras.\n\n" +
    `Nuestro equipo responde WhatsApp ${hoursText(s.human_hours)}.`;
  await sendButtons(db, conv, waId, body, BACK);
}

const REASONS: Record<string, string> = {
  human: "Pide hablar con alguien", question: "Tiene una pregunta", medical: "Pregunta de salud", photo: "Envió una foto",
  after_care: "⚠️ Molestia después de un tratamiento", urgent: "🚨 Posible urgencia", complaint: "Queja o reclamo",
  payment: "Pagos o reembolsos", audio: "Envió un audio", precios: "Pide precios", agendar: "Quiere que le agenden",
  servicios: "Pregunta sobre servicios", unknown: "Mensaje que el asistente no entendió",
};

export async function handOff(db: SupabaseClient, conv: Conv, waId: string, reason: string, s: Settings, preview = "") {
  const open = withinHumanHours(s.human_hours);
  const later = `Nuestro equipo responde ${hoursText(s.human_hours)}. Te escribimos apenas abramos. 💕`;
  const lead: Record<string, string> = {
    urgent: "Si tienes dolor fuerte, la piel se pone blanca o morada, te cuesta respirar o cambia tu vista, *llama al 911 o ve a urgencias ahora*. Ya avisamos a nuestro equipo médico con prioridad.",
    after_care: "Gracias por avisarnos. Ya le pasé tu mensaje a nuestro equipo médico con prioridad. Si el dolor es fuerte, la piel se pone blanca o morada o cambia tu vista, llama al 911 o ve a urgencias.",
    medical: "Esa pregunta es mejor que la responda nuestro equipo médico. Ya les avisé y te escriben por aquí.",
    photo: "Gracias por la foto. Para recomendarte algo, nuestro equipo médico necesita revisarla; ya les avisé y te escriben por aquí. También podemos agendarte una valoración.",
    complaint: "Lamento mucho lo que pasó. Le paso tu mensaje al equipo para que te responda personalmente.",
    payment: "Le paso tu consulta al equipo para que te ayude personalmente.",
    audio: "Recibí tu audio. 🎧 Nuestro equipo lo escucha y te responde por aquí.",
    question: "¡Gracias! Le pasé tu pregunta a nuestro equipo y te responden por aquí.",
    unknown: "Le pasé tu mensaje a nuestro equipo y te responden por aquí.",
  };
  const first = lead[reason] ?? "Claro, ya le avisé a nuestro equipo y te escriben por aquí en breve. 😊";
  const body = reason === "urgent" ? `${first}${open ? "" : `\n\n${later}`}` : `${first}${open ? " 😊" : `\n\n${later}`}`;
  const now = new Date().toISOString();
  await db.from("wa_conversations").update({
    bot_active: false, needs_attention: true, handoff_reason: reason, handoff_at: now, human_since: now, bot_state: null,
  }).eq("id", conv.id);
  await sendText(db, conv, waId, body);

  const { data: p } = conv.patient_id
    ? await db.from("profiles").select("first_name, last_name").eq("id", conv.patient_id).maybeSingle()
    : { data: null };
  const name = `${p?.first_name || ""} ${p?.last_name || ""}`.trim() || conv.profile_name || `+${waId}`;
  const { data: unreadChats } = await db.from("wa_conversations").select("id, unread_count").gt("unread_count", 0);
  await sendPushToStaff(db, {
    title: `🙋 ${name} · ${REASONS[reason] ?? "Pide ayuda"}`,
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
    .select("id, patient_id, profile_name, bot_state, bot_greeted_at").eq("id", conversationId).single();
  if (!conv) return false;
  const s = await loadSettings(db);

  if (m.type === "reaction") return true;

  // A tap in one of our menus.
  const tapped = m.type === "interactive" ? String(m.interactive?.list_reply?.id || m.interactive?.button_reply?.id || "") : "";
  if (tapped.startsWith("bot:")) {
    const [, action, arg] = tapped.split(":");
    switch (action) {
      case "menu": await mainMenu(db, conv, waId); return true;
      case "services": await servicesMenu(db, conv, waId, s); return true;
      case "cat": await categoryDetail(db, conv, waId, Number(arg) || 0, s); return true;
      case "book": await book(db, conv, waId); return true;
      case "mine": await mine(db, conv, waId); return true;
      case "info": await info(db, conv, waId, s); return true;
      case "question":
        await setState(db, conv, "await_question");
        await sendText(db, conv, waId, "Claro, cuéntame tu pregunta en un mensaje y se la paso a nuestro equipo. ✍️");
        return true;
      case "resched": {
        const outcome = await startReschedule(db, conv.id, waId, arg || null);
        if (outcome === "done") return true;
        await handOff(db, conv, waId, "agendar", s, "Quiere cambiar su cita");
        return true;
      }
      case "human": await handOff(db, conv, waId, arg || "human", s, body); return true;
    }
  }

  // Photos, documents, audio, video.
  if (["image", "video", "document", "sticker"].includes(m.type)) {
    if (m.type === "sticker") return true;
    await handOff(db, conv, waId, "photo", s, body || "📷 Archivo");
    return true;
  }
  if (m.type === "audio") { await handOff(db, conv, waId, "audio", s, "🎤 Audio"); return true; }

  const t = norm(body);
  if (!t) { await welcome(db, conv, waId, s); return true; }

  // Safety first: these always go to a person.
  if (has(t, URGENT)) { await handOff(db, conv, waId, "urgent", s, body); return true; }
  if (has(t, AFTER_CARE)) { await handOff(db, conv, waId, "after_care", s, body); return true; }
  if (has(t, MEDICAL)) { await handOff(db, conv, waId, "medical", s, body); return true; }
  if (has(t, COMPLAINT)) { await handOff(db, conv, waId, "complaint", s, body); return true; }
  if (has(t, PAYMENT)) { await handOff(db, conv, waId, "payment", s, body); return true; }
  if (has(t, HUMAN)) { await handOff(db, conv, waId, "human", s, body); return true; }

  // The patient was asked to write their question.
  if (conv.bot_state === "await_question") { await handOff(db, conv, waId, "question", s, body); return true; }

  const greetedRecently = conv.bot_greeted_at && Date.now() - new Date(conv.bot_greeted_at).getTime() < GREET_AGAIN_HOURS * 3600_000;
  const short = t.length <= 40;
  if (!greetedRecently) { await welcome(db, conv, waId, s); return true; }
  if (short && hasWord(t, GREETING)) { await welcome(db, conv, waId, s); return true; }
  if (short && hasWord(t, THANKS)) {
    await sendText(db, conv, waId, "¡Con gusto! 💕 Si necesitas algo más, aquí estoy. Escribe *menú* para ver las opciones.");
    return true;
  }
  if (has(t, BOOK)) { await book(db, conv, waId); return true; }
  if (has(t, INFO)) { await info(db, conv, waId, s); return true; }
  if (has(t, SERVICES)) { await servicesMenu(db, conv, waId, s); return true; }

  // Phase 1 doesn't read free text: a person answers.
  await handOff(db, conv, waId, "unknown", s, body);
  return true;
}
