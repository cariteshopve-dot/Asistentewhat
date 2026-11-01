// Entiende el mensaje del usuario, usa las herramientas y devuelve el texto de respuesta.
import Anthropic from "@anthropic-ai/sdk";
import type { DB, Usuario } from "./db.ts";
import { usuarioPorId } from "./db.ts";
import { herramientas } from "./herramientas.ts";
import { partesLocales } from "./fechas.ts";
import { listarVehiculos } from "./servicios.ts";

const cliente = new Anthropic();
const MODELO = process.env.MODELO ?? "claude-opus-5-5";
const ESFUERZO = (process.env.ESFUERZO ?? "low") as "low" | "medium" | "high";

const SISTEMA = `Eres el asistente de WhatsApp de lacosta.agency. Ayudas a la persona a llevar cuatro cosas desde el chat:
1. Gastos e ingresos en varias monedas (cada gasto guarda la tasa del día).
2. Vencimientos: suscripciones, pagos fijos, documentos, garantías, seguros.
3. El carro: vehículos, gasolina, mantenimientos.
4. Medicinas: tomas diarias para la persona o su familia, y cuántas quedan.

Cómo trabajar:
- Si el mensaje trae un dato para guardar, guárdalo con la herramienta que corresponde, sin pedir permiso. Un mensaje puede traer varios datos: guárdalos todos.
- Pregunta solo si falta algo imprescindible (por ejemplo, el monto). Si falta la moneda, usa la moneda local del usuario.
- "Gasté 20 en gasolina" es un gasto con categoría gasolina y, si hay un solo vehículo, ligado a ese vehículo.
- Interpreta fechas relativas ("mañana", "el 15", "cada mes") con la fecha de hoy que te doy.
- Si una herramienta devuelve un error de límite del plan gratis, explícalo en una línea y menciona que el plan Pro no tiene límites (escribe "pro" para saber más).
- No des consejos médicos ni financieros: solo registra, recuerda y resume.

Cómo responder:
- Español sencillo, o el idioma en que te escriban. Mensajes cortos, para leer en el teléfono.
- Confirma lo guardado en una línea, con montos y fechas. Ej: "Listo: gasolina 20 USD (≈ 7.300 Bs) ✅".
- Formato de WhatsApp: *negrita* con un asterisco, sin tablas ni encabezados de Markdown.`;

function contexto(db: DB, u: Usuario) {
  const { fecha, hora } = partesLocales(u.zona);
  const dia = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: u.zona }).format(new Date());
  const veh = (listarVehiculos(db, u) as any[]).map((v) => v.nombre).join(", ") || "ninguno";
  return `Hoy es ${dia} ${fecha}, son las ${hora} (${u.zona}). Usuario: ${u.nombre ?? "sin nombre"}. ` +
    `Moneda base: ${u.moneda_base}. Moneda local: ${u.moneda_local}. Plan: ${u.plan}. Vehículos: ${veh}.`;
}

function historial(db: DB, u: Usuario): Anthropic.Beta.BetaMessageParam[] {
  const filas = (db.prepare("SELECT rol, texto FROM mensajes WHERE usuario_id=? ORDER BY id DESC LIMIT 12").all(u.id) as any[]).reverse();
  // La conversación debe empezar con el usuario y alternar roles
  const msgs: Anthropic.Beta.BetaMessageParam[] = [];
  for (const f of filas) {
    if (!msgs.length && f.rol !== "user") continue;
    const ult = msgs[msgs.length - 1];
    if (ult && ult.role === f.rol) ult.content += "\n" + f.texto;
    else msgs.push({ role: f.rol, content: f.texto });
  }
  return msgs;
}

export async function responder(db: DB, usuarioId: number, texto: string): Promise<string> {
  const u = usuarioPorId(db, usuarioId)!;
  db.prepare("INSERT INTO mensajes (usuario_id, rol, texto) VALUES (?, 'user', ?)").run(u.id, texto);
  const mensajes = historial(db, u);

  const final = await cliente.beta.messages.toolRunner({
    model: MODELO,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: ESFUERZO },
    system: [
      { type: "text", text: SISTEMA, cache_control: { type: "ephemeral" } },
      { type: "text", text: contexto(db, u) },
    ],
    tools: herramientas(db, u),
    messages: mensajes,
    max_iterations: 8,
  });

  let respuesta: string;
  if (final.stop_reason === "refusal") {
    respuesta = "Disculpa, no puedo ayudar con eso. Puedo anotar gastos, vencimientos, cosas del carro y medicinas.";
  } else {
    respuesta = final.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("\n").trim()
      || "Listo ✅";
  }
  db.prepare("INSERT INTO mensajes (usuario_id, rol, texto) VALUES (?, 'assistant', ?)").run(u.id, respuesta);
  return respuesta;
}
