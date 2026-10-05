import webpush from "npm:web-push@3.6.7";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Phone/computer notifications for staff (Web Push), to every device saved in
// push_subscriptions — the admin turns them on from "Mensajes" → Activar avisos.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…).

export type PushPayload = { title: string; body: string; tag?: string; url?: string; conversationId?: string };

let configured = false;
function configure(): boolean {
  if (configured) return true;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return false;
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:pielspanyc@gmail.com", pub, priv);
  configured = true;
  return true;
}

// Returns how many devices it reached. Devices that no longer exist (the
// browser dropped the subscription) are removed.
export async function sendPushToStaff(db: SupabaseClient, payload: PushPayload, onlyUserId?: string): Promise<number> {
  if (!configure()) return 0;
  let query = db.from("push_subscriptions").select("id, endpoint, p256dh, auth");
  if (onlyUserId) query = query.eq("user_id", onlyUserId);
  const { data: subs } = await query;
  let delivered = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 6 * 3600, urgency: "high" },
      );
      delivered++;
      await db.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push:", status, (e as Error).message);
    }
  }));
  return delivered;
}
