// "Historic" patients: seen before the system existed and loaded by staff
// (e.g. the Divine Bliss import) — a profile with is_manual_patient = true and
// NO portal login. When one of them books online or fills the intake, we
// create their login with the SAME id as that profile, so their past visits,
// appointments and notes stay attached without moving any rows.
//
// Proof of identity is the name on file: the phone alone isn't enough to take
// over a record. Imported records have no date of birth or email to check.

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export type HistoricPatient = { id: string; first_name: string | null; last_name: string | null };

// The profile for this phone (matched on the last 10 digits, like the rest of
// the system) when it has no portal login yet; otherwise null.
export async function findHistoricPatient(adminClient: AdminClient, phoneDigits: string): Promise<HistoricPatient | null> {
  const last10 = phoneDigits.slice(-10);
  if (last10.length < 7) return null;
  const { data } = await adminClient
    .from("profiles").select("id, first_name, last_name, is_manual_patient")
    .ilike("phone", `%${last10}`).limit(2);
  // Two profiles with the same phone: ambiguous — leave it to staff.
  if (!data || data.length !== 1 || !data[0].is_manual_patient) return null;
  const { data: authUser } = await adminClient.auth.admin.getUserById(data[0].id);
  if (authUser?.user) return null;
  return { id: data[0].id, first_name: data[0].first_name, last_name: data[0].last_name };
}

function nameWords(value: unknown): string[] {
  return String(value ?? "")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[^a-z\s]/g, " ")
    .split(/\s+/).filter(Boolean);
}

// First name: the first words must agree, allowing a short form ("Leo" / "Leonardo").
// Last name: at least one word in common ("Osorio" matches "Osorio Fernandez"),
// skipped when the record has no last name.
export function nameMatchesRecord(record: HistoricPatient, firstName: string, lastName: string): boolean {
  const [recFirst] = nameWords(record.first_name);
  const [typedFirst] = nameWords(firstName);
  if (!recFirst || !typedFirst) return false;
  const firstOk = recFirst.startsWith(typedFirst) || typedFirst.startsWith(recFirst);
  const recLast = nameWords(record.last_name);
  const typedLast = nameWords(lastName);
  const lastOk = !recLast.length || recLast.some((w) => typedLast.includes(w));
  return firstOk && lastOk;
}
