// WhatsApp message templates (Utility, Spanish) used by the system. The body's
// {{1}}, {{2}}… are filled in this order by whoever sends them (params list).
// Created in Meta from here (whatsapp-diagnose ?templates=create); Meta reviews
// each one and may approve it as UTILITY or reclassify it as MARKETING.

export type TemplateDef = {
  name: string;
  params: string[];          // what {{1}}, {{2}}… mean, in order
  header?: string;           // optional text header (no variables)
  body: string;
  example: string[];         // sample values for Meta's review, same order as params
  buttons?: string[];        // quick replies (≤ 25 characters, no emojis, variables or line breaks)
};

export const TEMPLATE_LANGUAGE = "es";

export const TEMPLATES: TemplateDef[] = [
  {
    name: "confirmacion_cita",
    params: ["nombre", "lugar", "fecha", "hora"],
    body: "Hola {{1}}, tu cita en {{2}} quedó confirmada para el {{3}} a las {{4}}.\n\nTe enviaremos un recordatorio un día antes. Si necesitas cambiarla, toca el botón o responde a este mensaje.",
    example: ["María", "Piel Spa", "martes 27 de octubre", "3:00 PM"],
    buttons: ["Necesito cambiarla"],
  },
  {
    name: "recordatorio_cita",
    params: ["nombre", "fecha", "hora", "lugar"],
    header: "Recordatorio de tu cita",
    body: "Hola {{1}}, te recordamos tu cita de mañana {{2}} a las {{3}} en {{4}}.\n\nPor favor confírmanos si asistirás. Llega 15 minutos antes, con la cara limpia y el menor maquillaje posible.",
    example: ["María", "martes 27 de octubre", "3:00 PM", "Piel Spa"],
    buttons: ["Confirmo asistencia", "Reprogramar", "Cancelar cita"],
  },
  {
    name: "cita_cancelada",
    params: ["nombre", "fecha", "hora", "lugar"],
    body: "Hola {{1}}, lamentamos avisarte que tu cita del {{2}} a las {{3}} en {{4}} no podrá realizarse por un imprevisto de nuestra parte.\n\n¿Quieres reprogramarla? Toca un botón y te ayudamos.",
    example: ["María", "viernes 30 de octubre", "11:00 AM", "Divine Bliss Studio"],
    buttons: ["Sí, reprogramar", "Más adelante"],
  },
  {
    name: "cita_reprogramada",
    params: ["nombre", "fecha", "hora", "lugar"],
    body: "Hola {{1}}, tu cita fue cambiada al {{2}} a las {{3}} en {{4}}.\n\nPor favor confírmanos si te funciona el nuevo horario.",
    example: ["María", "sábado 31 de octubre", "4:30 PM", "Piel Spa"],
    buttons: ["Confirmo", "Necesito otro horario"],
  },
  {
    name: "recomendaciones_tratamiento",
    params: ["nombre", "tratamiento", "fecha"],
    body: "Hola {{1}}, gracias por tu visita a Piel Spa. Ya están listas las recomendaciones de tu {{2}} del {{3}}.\n\nToca el botón para recibirlas por aquí.",
    example: ["María", "aplicación de Botox", "23 de octubre"],
    buttons: ["Ver recomendaciones"],
  },
  {
    name: "seguimiento_tratamiento",
    params: ["nombre", "tratamiento", "fecha"],
    body: "Hola {{1}}, te escribimos de Piel Spa para saber cómo te has sentido después de tu {{2}} del {{3}}.\n\nSi tienes alguna molestia o pregunta, responde a este mensaje.",
    example: ["María", "aplicación de Botox", "23 de octubre"],
    buttons: ["Todo bien", "Tengo una pregunta"],
  },
  {
    name: "mensaje_tratamiento",
    params: ["nombre", "tratamiento", "fecha"],
    body: "Hola {{1}}, el equipo de Piel Spa tiene información sobre tu {{2}} del {{3}}.\n\n¿Te la enviamos por aquí?",
    example: ["María", "relleno de labios", "18 de septiembre"],
    buttons: ["Sí, envíenmela"],
  },
  {
    name: "recordatorio_retoque",
    params: ["nombre", "tratamiento", "fecha", "cuando"],
    body: "Hola {{1}}, según tu plan de tratamiento, tu control de {{2}} realizado el {{3}} corresponde para {{4}}.\n\nToca el botón o responde a este mensaje para coordinar tu cita.",
    example: ["María", "Botox", "9 de octubre", "esta semana"],
    buttons: ["Coordinar mi cita"],
  },
  {
    name: "contacto_consulta",
    params: ["nombre", "fecha"],
    body: "Hola {{1}}, te escribimos de Piel Spa sobre tu consulta del {{2}}. ¿Tienes un momento para conversar por aquí?",
    example: ["María", "18 de septiembre"],
    buttons: ["Sí, dime", "Ahora no"],
  },
];

// The components Meta expects when creating a template.
export function templateComponents(t: TemplateDef) {
  const components: Record<string, unknown>[] = [];
  if (t.header) components.push({ type: "HEADER", format: "TEXT", text: t.header });
  components.push({ type: "BODY", text: t.body, example: { body_text: [t.example] } });
  if (t.buttons?.length) components.push({ type: "BUTTONS", buttons: t.buttons.map((text) => ({ type: "QUICK_REPLY", text })) });
  return components;
}
