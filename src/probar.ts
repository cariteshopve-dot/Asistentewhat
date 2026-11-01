// Chatea con el asistente desde la terminal, sin WhatsApp: npm run probar
import { createInterface } from "node:readline/promises";
import { abrirDB } from "./db.ts";
import { procesar } from "./chat.ts";
import { revisarAvisos } from "./avisos.ts";

const db = abrirDB(process.env.DB_RUTA ?? "datos/prueba.db");
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("Escribe como si fuera WhatsApp. 'avisos' revisa los avisos ahora. Ctrl+C para salir.\n");
let i = 0;
while (true) {
  const texto = await rl.question("tú> ");
  if (texto.trim() === "avisos") {
    await revisarAvisos(db, async (_u, t) => console.log("aviso>", t));
    continue;
  }
  const r = await procesar(db, { waId: `local-${Date.now()}-${i++}`, de: "580000000000", nombre: "Prueba", tipo: "text", texto });
  console.log("asistente>", r, "\n");
}
