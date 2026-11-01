// Decide qué hacer con cada mensaje que llega por WhatsApp.
import type { DB } from "./db.ts";
import { usuarioPorTelefono } from "./db.ts";
import { responder } from "./ia.ts";
import { crearEnlace } from "./dashboard.ts";
import type { Entrante } from "./whatsapp.ts";

const LINK_PAGO = process.env.LINK_PAGO ?? "";

const BIENVENIDA = `¡Hola! 👋 Soy tu asistente. Escríbeme como a un amigo y yo lo anoto:
• "Gasté 15 dólares en mercado"
• "Netflix 9,99 cada 5 del mes"
• "Le cambié el aceite al carro, 85.000 km"
• "Mamá toma losartán a las 8 y a las 20"
Te aviso antes de cada vencimiento y a la hora de cada medicina. Escribe *panel* para ver todo en la web.`;

/** Devuelve el texto a enviar, o null si no hay que responder. */
export async function procesar(db: DB, m: Entrante): Promise<string | null> {
  if (!db.prepare("INSERT OR IGNORE INTO wa_recibidos (wa_id) VALUES (?)").run(m.waId).changes) return null; // repetido
  const u = usuarioPorTelefono(db, m.de, m.nombre);
  const nuevo = !u.ultimo_mensaje_at;
  db.prepare("UPDATE usuarios SET ultimo_mensaje_at=datetime('now') WHERE id=?").run(u.id);

  if (!m.texto) {
    return m.tipo === "audio"
      ? "Por ahora solo entiendo mensajes escritos. Pronto podré escuchar notas de voz 🎙️"
      : "Por ahora solo entiendo mensajes de texto.";
  }
  const t = m.texto.trim().toLowerCase();
  if (nuevo && /^(hola|buenas|hi|hello|empezar|start)\b/.test(t)) return BIENVENIDA;
  if (/^(panel|dashboard|web)$/.test(t)) return `Aquí está tu panel (el enlace sirve 15 minutos):\n${crearEnlace(db, u)}`;
  if (/^(ayuda|help|\?)$/.test(t)) return BIENVENIDA;
  if (/^pro$/.test(t)) {
    return LINK_PAGO
      ? `El plan *Pro* quita los límites (gastos, vencimientos, vehículos y medicinas sin tope). Lo activas aquí:\n${LINK_PAGO}?checkout[custom][telefono]=${u.telefono}`
      : "El plan Pro llegará pronto. Te aviso cuando esté listo.";
  }
  const respuesta = await responder(db, u.id, m.texto);
  return nuevo ? `${respuesta}\n\n_Escribe *ayuda* para ver qué más puedo hacer._` : respuesta;
}
