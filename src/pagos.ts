// Lemon Squeezy: activa o quita el plan Pro cuando llega el aviso de pago.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";

export function firmaLemonValida(cuerpo: Buffer, firma: string | undefined, secreto = process.env.LEMON_SECRETO ?? "") {
  if (!secreto || !firma) return false;
  const esperada = Buffer.from(createHmac("sha256", secreto).update(cuerpo).digest("hex"));
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

/** Devuelve el teléfono afectado, o null si el evento no nos interesa. */
export function aplicarEventoLemon(db: DB, evento: any): string | null {
  const nombre: string = evento?.meta?.event_name ?? "";
  const telefono: string | undefined = evento?.meta?.custom_data?.telefono;
  if (!telefono || !nombre.startsWith("subscription_")) return null;
  const a = evento.data?.attributes ?? {};
  const activa = ["active", "on_trial", "past_due"].includes(a.status);
  // Si la cancelan, sigue Pro hasta el final del período pagado
  const hasta = (a.ends_at ?? a.renews_at ?? null)?.slice(0, 10) ?? null;
  const plan = activa || (a.status === "cancelled" && hasta) ? "pro" : "gratis";
  db.prepare("UPDATE usuarios SET plan=?, plan_hasta=? WHERE telefono=?").run(plan, plan === "pro" ? hasta : null, telefono);
  return telefono;
}
