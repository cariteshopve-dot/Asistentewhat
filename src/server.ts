// Servidor: webhook de WhatsApp, panel web y revisión de avisos.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { abrirDB } from "./db.ts";
import { firmaValida, extraerMensajes, enviarTexto, enviarAviso, marcarLeido } from "./whatsapp.ts";
import { procesar } from "./chat.ts";
import { revisarAvisos } from "./avisos.ts";
import { firmaLemonValida, aplicarEventoLemon } from "./pagos.ts";
import { canjearEnlace, usuarioDeSesion, cerrarSesion, paginaPanel, paginaMensaje } from "./dashboard.ts";

const db = abrirDB();
const PUERTO = Number(process.env.PORT ?? 3000);
const VERIFY = process.env.WA_VERIFY_TOKEN ?? "";

function leerCuerpo(req: IncomingMessage, limite = 1_000_000): Promise<Buffer> {
  return new Promise((ok, mal) => {
    const partes: Buffer[] = []; let total = 0;
    req.on("data", (c: Buffer) => { total += c.length; if (total > limite) { req.destroy(); mal(new Error("muy grande")); } else partes.push(c); });
    req.on("end", () => ok(Buffer.concat(partes)));
    req.on("error", mal);
  });
}

const cookie = (req: IncomingMessage, nombre: string) =>
  (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === nombre)?.[1];

function html(res: ServerResponse, codigo: number, cuerpo: string, extra: Record<string, string> = {}) {
  res.writeHead(codigo, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra }).end(cuerpo);
}

async function atenderMensajes(payload: unknown) {
  for (const m of extraerMensajes(payload)) {
    try {
      marcarLeido(m.waId);
      const texto = await procesar(db, m);
      if (texto) await enviarTexto(m.de, texto);
    } catch (e) {
      console.error("error con mensaje", m.waId, e);
      await enviarTexto(m.de, "Uy, algo falló de mi lado. Intenta de nuevo en un momento 🙏").catch(() => {});
    }
  }
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/webhook" && req.method === "GET") {
      // Meta verifica la URL una vez al configurarla
      if (url.searchParams.get("hub.mode") === "subscribe" && VERIFY && url.searchParams.get("hub.verify_token") === VERIFY)
        return res.writeHead(200).end(url.searchParams.get("hub.challenge"));
      return res.writeHead(403).end();
    }
    if (url.pathname === "/webhook" && req.method === "POST") {
      const cuerpo = await leerCuerpo(req);
      if (!firmaValida(cuerpo, req.headers["x-hub-signature-256"] as string | undefined)) return res.writeHead(401).end();
      res.writeHead(200).end(); // responder rápido; Meta reintenta si tardamos
      atenderMensajes(JSON.parse(cuerpo.toString("utf8")));
      return;
    }
    if (url.pathname === "/entrar") {
      const sesion = canjearEnlace(db, url.searchParams.get("t") ?? "");
      if (!sesion) return html(res, 400, paginaMensaje("Enlace vencido", "Escribe «panel» en WhatsApp para recibir uno nuevo."));
      return html(res, 302, "", {
        Location: "/",
        "Set-Cookie": `sesion=${sesion}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`,
      });
    }
    if (url.pathname === "/salir") {
      cerrarSesion(db, cookie(req, "sesion"));
      return html(res, 302, "", { Location: "/", "Set-Cookie": "sesion=; Path=/; Max-Age=0" });
    }
    if (url.pathname === "/pago" && req.method === "POST") {
      const cuerpo = await leerCuerpo(req);
      if (!firmaLemonValida(cuerpo, req.headers["x-signature"] as string | undefined)) return res.writeHead(401).end();
      const tel = aplicarEventoLemon(db, JSON.parse(cuerpo.toString("utf8")));
      if (tel) console.log("plan actualizado", tel.slice(0, 4) + "…");
      return res.writeHead(200).end();
    }
    if (url.pathname === "/salud") return res.writeHead(200).end("ok");
    if (url.pathname === "/") {
      const u = usuarioDeSesion(db, cookie(req, "sesion"));
      if (!u) return html(res, 200, paginaMensaje("Tu asistente", "Escribe «panel» en WhatsApp para entrar a tu panel."));
      return html(res, 200, paginaPanel(db, u, url.searchParams.get("mes") ?? undefined));
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

servidor.listen(PUERTO, () => console.log(`Asistente escuchando en el puerto ${PUERTO}`));

// Avisos: revisar cada 5 minutos
const vuelta = () => revisarAvisos(db, (u, texto) => enviarAviso(db, u, texto)).catch((e) => console.error("avisos", e));
setInterval(vuelta, 5 * 60 * 1000);
vuelta();
