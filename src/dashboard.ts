// Panel web: el usuario escribe "panel" en WhatsApp y recibe un enlace de entrada de un solo uso.
import { randomBytes } from "node:crypto";
import type { DB, Usuario } from "./db.ts";
import { usuarioPorId } from "./db.ts";
import { hoy, sumarDias } from "./fechas.ts";
import * as s from "./servicios.ts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ENLACE_MIN = 15;          // el enlace del chat sirve 15 minutos
const SESION_DIAS = 30;

export function crearEnlace(db: DB, u: Usuario) {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sesiones (token, usuario_id, expira_at) VALUES (?,?,datetime('now', ?))")
    .run("e:" + token, u.id, `+${ENLACE_MIN} minutes`);
  return `${BASE_URL}/entrar?t=${token}`;
}

/** Cambia el enlace de un solo uso por una sesión con cookie. */
export function canjearEnlace(db: DB, token: string): string | null {
  const fila = db.prepare("SELECT usuario_id FROM sesiones WHERE token=? AND expira_at > datetime('now')").get("e:" + token) as any;
  db.prepare("DELETE FROM sesiones WHERE token=?").run("e:" + token);
  if (!fila) return null;
  const sesion = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sesiones (token, usuario_id, expira_at) VALUES (?,?,datetime('now', ?))")
    .run("s:" + sesion, fila.usuario_id, `+${SESION_DIAS} days`);
  return sesion;
}

export function usuarioDeSesion(db: DB, sesion: string | undefined): Usuario | undefined {
  if (!sesion) return;
  const fila = db.prepare("SELECT usuario_id FROM sesiones WHERE token=? AND expira_at > datetime('now')").get("s:" + sesion) as any;
  return fila ? usuarioPorId(db, fila.usuario_id) : undefined;
}

export function cerrarSesion(db: DB, sesion: string | undefined) {
  if (sesion) db.prepare("DELETE FROM sesiones WHERE token=?").run("s:" + sesion);
}

const esc = (x: unknown) => String(x ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (x: number) => x.toLocaleString("es-VE", { maximumFractionDigits: 2 });

export function paginaPanel(db: DB, u: Usuario, mes?: string): string {
  const h = hoy(u.zona);
  const m = /^\d{4}-\d{2}$/.test(mes ?? "") ? mes! : h.slice(0, 7);
  const fin = sumarDias(sumarDias(m + "-01", 32).slice(0, 8) + "01", -1);
  const r = s.resumenGastos(db, u, m + "-01", fin);
  const max = Math.max(1, ...r.por_categoria.map((c) => c.total));
  const movs = db.prepare(`SELECT tipo,monto_centavos/100.0 monto,moneda,categoria,nota,fecha FROM movimientos
    WHERE usuario_id=? AND substr(fecha,1,7)=? ORDER BY fecha DESC,id DESC LIMIT 50`).all(u.id, m) as any[];
  const venc = s.proximosVencimientos(db, u, 60);
  const vehs = s.listarVehiculos(db, u) as any[];
  const meds = s.listarMedicinas(db, u) as any[];
  const tomas = db.prepare(`SELECT estado, count(*) n FROM tomas t JOIN medicinas me ON me.id=t.medicina_id
    WHERE me.usuario_id=? AND t.programada >= ? GROUP BY estado`).all(u.id, sumarDias(h, -6)) as any[];
  const tomadas = tomas.find((t) => t.estado === "tomada")?.n ?? 0;
  const totalTomas = tomas.reduce((a, t) => a + Number(t.n), 0);
  const mesAnt = sumarDias(m + "-01", -1).slice(0, 7);
  const mesSig = sumarDias(m + "-01", 32).slice(0, 7);
  const color = (d: number) => d < 0 ? "rojo" : d <= 3 ? "ambar" : "verde";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mi panel</title><style>
:root{--fondo:#0E1A14;--tarjeta:#16261D;--linea:#24382C;--texto:#E8F2EC;--suave:#93A89B;--verde:#3DDC84;--ambar:#F5B83D;--rojo:#FF6B6B}
*{box-sizing:border-box}body{margin:0;background:var(--fondo);color:var(--texto);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:16px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 12px;color:var(--suave);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
a{color:var(--verde)}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.t{background:var(--tarjeta);border:1px solid var(--linea);border-radius:14px;padding:16px}
.cifra{font-size:28px;font-weight:700}.sub{color:var(--suave);font-size:13px}
.fila{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--linea)}.fila:last-child{border:0}
.barra{height:8px;border-radius:4px;background:var(--verde);margin-top:4px}
.punto{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}.verde{background:var(--verde)}.ambar{background:var(--ambar)}.rojo{background:var(--rojo)}
.mes{display:flex;gap:12px;align-items:center}.vacio{color:var(--suave)}footer{margin:24px 0 8px;color:var(--suave);font-size:12px;text-align:center}
</style></head><body><main>
<header><h1>Hola${u.nombre ? ", " + esc(u.nombre) : ""}</h1><a href="/salir">Salir</a></header>
<div class="mes"><a href="/?mes=${mesAnt}">‹</a><strong>${esc(m)}</strong><a href="/?mes=${mesSig}">›</a></div><br>
<div class="grid">
 <section class="t"><h2>Gastos del mes</h2><div class="cifra">${num(r.total_gastos)} ${esc(r.moneda)}</div>
  <div class="sub">Ingresos: ${num(r.total_ingresos)} ${esc(r.moneda)}</div><br>
  ${r.por_categoria.map((c) => `<div class="fila"><span>${esc(c.categoria)}</span><span>${num(c.total)}</span></div><div class="barra" style="width:${(c.total / max) * 100}%"></div>`).join("") || '<p class="vacio">Sin gastos este mes.</p>'}
 </section>
 <section class="t"><h2>Vencimientos</h2>
  ${venc.map((v) => `<div class="fila"><span><span class="punto ${color(v.faltan_dias)}"></span>${esc(v.nombre)}</span><span class="sub">${v.faltan_dias < 0 ? "vencido" : v.faltan_dias === 0 ? "hoy" : "en " + v.faltan_dias + " d"} · ${esc(v.fecha)}</span></div>`).join("") || '<p class="vacio">Nada por vencer en 60 días.</p>'}
 </section>
 <section class="t"><h2>Carro</h2>
  ${vehs.map((v) => { const hv = s.historialVehiculo(db, u, v.nombre) as any; return `<div class="fila"><span>${esc(v.nombre)}</span><span class="sub">${v.km_actual ? num(v.km_actual) + " km · " : ""}${num(hv.gastos_mes)} ${esc(u.moneda_base)} este mes</span></div>`; }).join("") || '<p class="vacio">Sin vehículos.</p>'}
 </section>
 <section class="t"><h2>Medicinas</h2>
  ${totalTomas ? `<div class="sub">Últimos 7 días: ${tomadas} de ${totalTomas} tomas marcadas</div><br>` : ""}
  ${meds.map((x) => `<div class="fila"><span>${esc(x.nombre)}${x.perfil !== "yo" ? ` <span class="sub">(${esc(x.perfil)})</span>` : ""}</span><span class="sub">${esc(x.horas)}${x.quedan != null ? " · quedan " + x.quedan : ""}</span></div>`).join("") || '<p class="vacio">Sin medicinas.</p>'}
 </section>
</div><br>
<section class="t"><h2>Movimientos de ${esc(m)}</h2>
 ${movs.map((x) => `<div class="fila"><span>${esc(x.fecha.slice(5))} · ${esc(x.categoria)}${x.nota ? ` <span class="sub">${esc(x.nota)}</span>` : ""}</span><span>${x.tipo === "ingreso" ? "+" : "−"}${num(x.monto)} ${esc(x.moneda)}</span></div>`).join("") || '<p class="vacio">Sin movimientos.</p>'}
</section>
<footer>Hecho por lacosta.agency</footer></main></body></html>`;
}

export const paginaMensaje = (titulo: string, texto: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)}</title>
<style>body{margin:0;background:#0E1A14;color:#E8F2EC;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;text-align:center}</style>
</head><body><div><h1>${esc(titulo)}</h1><p>${esc(texto)}</p></div></body></html>`;
