// WhatsApp Business Cloud API (Meta): recibir mensajes y enviar respuestas o avisos.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DB, Usuario } from "./db.ts";

const VERSION = process.env.WA_VERSION ?? "v21.0";
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID ?? "";
const TOKEN = process.env.WA_TOKEN ?? "";
const PLANTILLA = process.env.WA_PLANTILLA_AVISO ?? "aviso_general";
const IDIOMA_PLANTILLA = process.env.WA_PLANTILLA_IDIOMA ?? "es";

export interface Entrante { waId: string; de: string; nombre?: string; tipo: string; texto?: string }

/** Meta firma cada POST con la clave secreta de la app. Si no coincide, se ignora. */
export function firmaValida(cuerpo: Buffer, firma: string | undefined, secreto = process.env.WA_APP_SECRET ?? ""): boolean {
  if (!secreto) return process.env.NODE_ENV !== "production"; // en desarrollo se permite sin clave
  if (!firma?.startsWith("sha256=")) return false;
  const esperada = Buffer.from("sha256=" + createHmac("sha256", secreto).update(cuerpo).digest("hex"));
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

export function extraerMensajes(payload: any): Entrante[] {
  const salida: Entrante[] = [];
  for (const entry of payload?.entry ?? []) for (const ch of entry.changes ?? []) {
    const v = ch.value ?? {};
    const nombres = Object.fromEntries((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
    for (const m of v.messages ?? []) {
      const texto = m.type === "text" ? m.text?.body
        : m.type === "button" ? m.button?.text
        : m.type === "interactive" ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title)
        : undefined;
      salida.push({ waId: m.id, de: m.from, nombre: nombres[m.from], tipo: m.type, texto });
    }
  }
  return salida;
}

async function enviar(cuerpo: object) {
  if (!PHONE_ID || !TOKEN) {
    console.log("[whatsapp simulado]", JSON.stringify(cuerpo));
    return;
  }
  const r = await fetch(`https://graph.facebook.com/${VERSION}/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...cuerpo }),
  });
  if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${await r.text()}`);
}

export const enviarTexto = (a: string, texto: string) =>
  enviar({ to: a, type: "text", text: { body: texto.slice(0, 4096), preview_url: true } });

export const marcarLeido = (waId: string) =>
  enviar({ status: "read", message_id: waId }).catch(() => {});

/** Dentro de las 24 h desde el último mensaje del usuario se puede escribir libre (gratis).
 *  Fuera de esa ventana Meta exige una plantilla aprobada (cuesta por mensaje). */
export function dentroDeVentana(u: Usuario, ahora = Date.now()) {
  return !!u.ultimo_mensaje_at && ahora - Date.parse(u.ultimo_mensaje_at + "Z") < 23.5 * 3600 * 1000;
}

export async function enviarAviso(db: DB, u: Usuario, texto: string) {
  const fresco = db.prepare("SELECT * FROM usuarios WHERE id=?").get(u.id) as unknown as Usuario;
  if (dentroDeVentana(fresco)) return enviarTexto(u.telefono, texto);
  // Plantilla de categoría "utilidad" con un parámetro: {{1}}. Los parámetros no admiten saltos de línea.
  return enviar({
    to: u.telefono, type: "template",
    template: {
      name: PLANTILLA, language: { code: IDIOMA_PLANTILLA },
      components: [{ type: "body", parameters: [{ type: "text", text: texto.replace(/\s*\n+\s*/g, " · ").slice(0, 1000) }] }],
    },
  });
}
