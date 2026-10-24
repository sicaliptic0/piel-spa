import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clinicDate, formatTime12h } from "../_shared/clinic.ts";
import { clinicPlaces, dayEs, placeFor } from "../_shared/appointmentText.ts";
import { sendWhatsAppMessage } from "../_shared/whatsapp.ts";
import { sendPushToStaff } from "../_shared/push.ts";

// Patients move their own appointment by WhatsApp, with tap-to-choose menus
// (interactive lists — free, since the patient just wrote):
//   "Reprogramar" → menu: the earliest free turn + the next free days
//   day           → menu: that day's free turns
//   turn          → patient_reschedule_appointment(), confirmation, staff push
// Every menu has "Hablar con alguien", which hands the chat to staff.
// Row ids carry the step: rs:day:<appt>:<date>[:<offset>] · rs:slot:<appt>:<date>:<HH:MM>
// · rs:days:<appt> · rs:human:<appt>.

// deno-lint-ignore no-explicit-any
type Json = any;
type Outcome = "done" | "staff";

const DAYS_AHEAD = 30;
const MAX_DAYS = 8;      // + earliest turn + "Hablar con alguien" = 10 rows (WhatsApp's limit)
const TIMES_PER_PAGE = 7;

function dayShort(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const weekday = d.toLocaleDateString("es-ES", { timeZone: "UTC", weekday: "long" });
  const month = d.toLocaleDateString("es-ES", { timeZone: "UTC", month: "short" }).replace(".", "");
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${d.getUTCDate()} ${month}`;
}
function turns(n: number): string { return `${n} turno${n === 1 ? "" : "s"} disponible${n === 1 ? "" : "s"}`; }

// The appointment, only if it belongs to whoever is writing.
async function ownAppointment(db: SupabaseClient, appointmentId: string, conversationId: string, waId: string): Promise<Json | null> {
  const { data: appt } = await db.from("appointments")
    .select("id, patient_id, appointment_date, appointment_time, status, location, duration_minutes, profiles(first_name, last_name, phone)")
    .eq("id", appointmentId).maybeSingle();
  if (!appt) return null;
  const { data: conv } = await db.from("wa_conversations").select("patient_id").eq("id", conversationId).maybeSingle();
  const profile = Array.isArray(appt.profiles) ? appt.profiles[0] : appt.profiles;
  const samePatient = conv?.patient_id && String(conv.patient_id) === String(appt.patient_id);
  const samePhone = String(profile?.phone || "").replace(/\D/g, "").slice(-10) === waId.slice(-10);
  return samePatient || samePhone ? appt : null;
}

async function freeSlots(db: SupabaseClient, appt: Json, from: string, to: string): Promise<Record<string, string[]>> {
  const { data, error } = await db.rpc("clinic_free_slots", {
    p_clinic: appt.location || "piel_spa",
    p_from: from,
    p_to: to,
    p_duration: Number(appt.duration_minutes) || 60,
    p_exclude_appointment: String(appt.id),
    p_lead: "2 hours",
  });
  if (error) throw new Error(error.message);
  // Not the turn they already have.
  const current = appt.status === "cancelled" ? "" : `${appt.appointment_date} ${String(appt.appointment_time).slice(0, 5)}`;
  const byDay: Record<string, string[]> = {};
  (data || []).forEach((s: Json) => {
    const time = String(s.slot_time).slice(0, 5);
    if (`${s.slot_date} ${time}` !== current) (byDay[s.slot_date] = byDay[s.slot_date] || []).push(time);
  });
  return byDay;
}

// Sends a text or a list and keeps a readable copy in the chat.
async function send(db: SupabaseClient, conversationId: string, waId: string, payload: Record<string, unknown>, copy: string, appointmentId?: string) {
  let waMessageId = "";
  let sendError = "";
  try {
    waMessageId = await sendWhatsAppMessage(waId, payload);
  } catch (e) {
    sendError = (e as Error).message;
  }
  await db.from("wa_messages").insert({
    conversation_id: conversationId, direction: "out", sender: "system", body: copy,
    wa_message_id: waMessageId || null, status: sendError ? "failed" : "sent", error: sendError || null,
    appointment_id: appointmentId || null,
  });
}
const text = (body: string) => ({ type: "text", text: { body } });

async function handOver(db: SupabaseClient, conversationId: string, waId: string, message: string): Promise<Outcome> {
  await send(db, conversationId, waId, text(message), message);
  return "staff";
}

// Step 1: the earliest turn and the next free days.
export async function sendDayMenu(db: SupabaseClient, conversationId: string, waId: string, appt: Json): Promise<Outcome> {
  const byDay = await freeSlots(db, appt, clinicDate(0), clinicDate(DAYS_AHEAD));
  const days = Object.keys(byDay).sort().slice(0, MAX_DAYS);
  if (!days.length) {
    return handOver(db, conversationId, waId, "Por ahora no vemos turnos disponibles en los próximos días. En un momento te escribimos para ayudarte. 😊");
  }
  const places = await clinicPlaces(db);
  const place = placeFor(places, appt.location);
  const first = days[0];
  const current = appt.status === "cancelled"
    ? "Elige el día para tu nueva cita"
    : `Tu cita actual es el ${dayEs(appt.appointment_date)} a las ${formatTime12h(String(appt.appointment_time).slice(0, 5))}. Elige el nuevo día`;
  const body = `${current} en ${place}:`;
  const earliest = { id: `rs:slot:${appt.id}:${first}:${byDay[first][0]}`, title: `${dayShort(first)} · ${formatTime12h(byDay[first][0])}`.slice(0, 24), description: "El próximo turno disponible" };
  const dayRows = days.map((d) => ({ id: `rs:day:${appt.id}:${d}`, title: dayShort(d).slice(0, 24), description: turns(byDay[d].length) }));
  await send(db, conversationId, waId, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: {
        button: "Ver días",
        sections: [
          { title: "Lo más pronto", rows: [earliest] },
          { title: "Elige el día", rows: dayRows },
          { title: "Otra opción", rows: [{ id: `rs:human:${appt.id}`, title: "Hablar con alguien" }] },
        ],
      },
    },
  }, [body, `• ${earliest.title} (el próximo turno)`, ...dayRows.map((r) => `• ${r.title} — ${r.description}`), "• Hablar con alguien"].join("\n"), String(appt.id));
  return "done";
}

// Step 2: that day's free turns.
async function sendTimeMenu(db: SupabaseClient, conversationId: string, waId: string, appt: Json, day: string, offset: number, lead = ""): Promise<Outcome> {
  const times = (await freeSlots(db, appt, day, day))[day] || [];
  if (!times.length) {
    await send(db, conversationId, waId, text("Ese día ya no tiene turnos disponibles. 😕"), "Ese día ya no tiene turnos disponibles. 😕", String(appt.id));
    return sendDayMenu(db, conversationId, waId, appt);
  }
  const page = times.slice(offset, offset + TIMES_PER_PAGE);
  const rows = page.map((t) => ({ id: `rs:slot:${appt.id}:${day}:${t}`, title: formatTime12h(t) }));
  if (offset + TIMES_PER_PAGE < times.length) rows.push({ id: `rs:day:${appt.id}:${day}:${offset + TIMES_PER_PAGE}`, title: "Más tarde…" });
  rows.push({ id: `rs:days:${appt.id}`, title: "Otro día" });
  rows.push({ id: `rs:human:${appt.id}`, title: "Hablar con alguien" });
  const body = `${lead}Turnos disponibles el ${dayEs(day)}:`;
  await send(db, conversationId, waId, {
    type: "interactive",
    interactive: { type: "list", body: { text: body }, action: { button: "Ver horas", sections: [{ title: "Elige la hora", rows }] } },
  }, [body, ...rows.map((r) => `• ${r.title}`)].join("\n"), String(appt.id));
  return "done";
}

// Step 3: move it.
async function bookSlot(db: SupabaseClient, conversationId: string, waId: string, appt: Json, day: string, time: string): Promise<Outcome> {
  const { error } = await db.rpc("patient_reschedule_appointment", { p_appointment_id: String(appt.id), p_date: day, p_time: time });
  if (error) {
    if (String(error.message).includes("slot_not_available")) {
      return sendTimeMenu(db, conversationId, waId, appt, day, 0, "Ese turno se acaba de ocupar 😕 ");
    }
    console.error("patient_reschedule_appointment:", error.message);
    return handOver(db, conversationId, waId, "No pudimos cambiar tu cita en este momento. En un momento te escribimos para ayudarte. 😊");
  }
  const place = placeFor(await clinicPlaces(db), appt.location);
  const confirmation = `¡Listo! Tu cita quedó para el ${dayEs(day)} a las ${formatTime12h(time)} en ${place}. Te esperamos. 💕`;
  await send(db, conversationId, waId, text(confirmation), confirmation, String(appt.id));

  // Staff only needs to know.
  const profile = Array.isArray(appt.profiles) ? appt.profiles[0] : appt.profiles;
  const name = `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() || `+${waId}`;
  await sendPushToStaff(db, {
    title: "📅 Cita cambiada por el paciente",
    body: `${name} → ${dayEs(day)}, ${formatTime12h(time)}`,
    tag: `resched-${appt.id}`,
    url: "/admin.html",
  }).catch((e) => console.error("reschedule push:", (e as Error).message));
  return "done";
}

// A row tapped in one of the menus above. null = not ours.
export async function handleRescheduleReply(db: SupabaseClient, conversationId: string, waId: string, rowId: string): Promise<Outcome | null> {
  const [prefix, step, appointmentId, day, extra] = rowId.split(":");
  if (prefix !== "rs" || !appointmentId) return null;
  const appt = await ownAppointment(db, appointmentId, conversationId, waId);
  if (!appt) return handOver(db, conversationId, waId, "No encontramos esa cita. En un momento te escribimos para ayudarte. 😊");
  if (step === "human") return handOver(db, conversationId, waId, "Claro, en un momento te escribimos. 😊");
  if (step === "days") return sendDayMenu(db, conversationId, waId, appt);
  if (step === "day" && day) return sendTimeMenu(db, conversationId, waId, appt, day, Number(extra) || 0);
  // The time keeps its colon: "rs:slot:<id>:<date>:<HH>:<MM>".
  if (step === "slot" && day && extra) return bookSlot(db, conversationId, waId, appt, day, `${extra}:${rowId.split(":")[5] || "00"}`);
  return null;
}

// Starting point from a template button: the appointment that message was about.
export async function startReschedule(db: SupabaseClient, conversationId: string, waId: string, appointmentId: string | null): Promise<Outcome | null> {
  if (!appointmentId) return null;
  const appt = await ownAppointment(db, appointmentId, conversationId, waId);
  if (!appt || appt.appointment_date < clinicDate(0)) return null;
  try {
    return await sendDayMenu(db, conversationId, waId, appt);
  } catch (e) {
    console.error("reschedule menu:", (e as Error).message);
    return null;
  }
}
