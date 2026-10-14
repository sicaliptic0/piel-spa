// Signed "darse de baja" links for announcement emails: baja.html#t=<patientId>.<sig>
// The signature (HMAC with the ANNOUNCE_SECRET secret) means the link only works
// for the patient it was sent to.

async function sign(patientId: string): Promise<string> {
  const secret = Deno.env.get("ANNOUNCE_SECRET") ?? "";
  if (!secret) throw new Error("ANNOUNCE_SECRET not set");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`unsubscribe:${patientId}`)));
  return Array.from(sig).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function unsubscribeLink(patientId: string): Promise<string> {
  return `https://piel-spa.com/baja.html#t=${patientId}.${await sign(patientId)}`;
}

// Returns the patient id if the token is genuine, else null.
export async function verifyUnsubscribeToken(token: string): Promise<string | null> {
  const [patientId, sig] = String(token || "").split(".");
  if (!patientId || !sig || !/^[0-9a-f-]{36}$/i.test(patientId)) return null;
  const expected = await sign(patientId);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? patientId : null;
}
