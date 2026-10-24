import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Wording shared by the WhatsApp appointment messages (templates and the
// automatic answers to their buttons): "lunes, 26 de octubre" and the clinic
// with its address, as the admin page writes them.

const PLACE_DEFAULTS: Record<string, string> = {
  piel_spa: "Piel Spa (481 8th Ave, Suite 1221, New York, NY 10001)",
  divine_bliss: "Divine Bliss Studio (529 Milltown Rd, North Brunswick Township, NJ 08902)",
};

export function dayEs(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("es-ES", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
  });
}

// clinic id → "Name (address)", from the clinics table (defaults if it's missing).
export async function clinicPlaces(db: SupabaseClient): Promise<Record<string, string>> {
  const places = { ...PLACE_DEFAULTS };
  const { data } = await db.from("clinics").select("id, name, address");
  (data || []).forEach((c) => { places[c.id] = c.address ? `${c.name} (${c.address})` : c.name; });
  return places;
}

export function placeFor(places: Record<string, string>, location: unknown): string {
  return places[String(location || "piel_spa")] || places.piel_spa;
}
