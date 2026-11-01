// Operaciones sobre los datos. No saben nada de WhatsApp ni de la IA, así se pueden probar solas.
import type { DB, Usuario } from "./db.ts";
import { hoy, sumarDias, diasEntre } from "./fechas.ts";
import { tasa } from "./tasas.ts";

export const LIMITES_GRATIS = { movimientosMes: 60, vencimientos: 5, vehiculos: 1, medicinas: 3 };

export class LimiteAlcanzado extends Error {}

/** Sin acentos ni mayúsculas, para que "losartan" encuentre "Losartán". */
export const normalizar = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
function porNombre<T extends { nombre: string }>(filas: T[], buscado: string): T | undefined {
  const b = normalizar(buscado);
  return filas.find((f) => normalizar(f.nombre) === b) ?? filas.find((f) => normalizar(f.nombre).includes(b) || b.includes(normalizar(f.nombre)));
}

const esPro = (u: Usuario) => u.plan === "pro" && (!u.plan_hasta || u.plan_hasta >= hoy(u.zona));
const aCentavos = (monto: number) => Math.round(monto * 100);
export const deCentavos = (c: number) => c / 100;
const n = (db: DB, sql: string, ...p: any[]) => Number((db.prepare(sql).get(...p) as any).n);

function verificarLimite(db: DB, u: Usuario, que: keyof typeof LIMITES_GRATIS) {
  if (esPro(u)) return;
  const mes = hoy(u.zona).slice(0, 7);
  const usados = {
    movimientosMes: () => n(db, "SELECT count(*) n FROM movimientos WHERE usuario_id=? AND substr(fecha,1,7)=?", u.id, mes),
    vencimientos: () => n(db, "SELECT count(*) n FROM vencimientos WHERE usuario_id=? AND activo=1", u.id),
    vehiculos: () => n(db, "SELECT count(*) n FROM vehiculos WHERE usuario_id=?", u.id),
    medicinas: () => n(db, "SELECT count(*) n FROM medicinas WHERE usuario_id=? AND activo=1", u.id),
  }[que]();
  if (usados >= LIMITES_GRATIS[que]) throw new LimiteAlcanzado(`Límite del plan gratis: ${LIMITES_GRATIS[que]} ${que}`);
}

// ---------- Gastos (DuoCash) ----------
export async function registrarMovimiento(db: DB, u: Usuario, m: {
  tipo: "gasto" | "ingreso"; monto: number; moneda: string; categoria: string;
  nota?: string | null; fecha?: string | null; tasa_propia?: number | null; vehiculo?: string | null;
}) {
  verificarLimite(db, u, "movimientosMes");
  const moneda = m.moneda.toUpperCase();
  // tasa_propia: cuántas unidades de moneda local por 1 de moneda base (ej. 40 Bs por dólar)
  let t: number;
  if (m.tasa_propia && moneda === u.moneda_local) t = 1 / m.tasa_propia;
  else t = await tasa(moneda, u.moneda_base);
  const vehiculoId = m.vehiculo ? buscarVehiculo(db, u, m.vehiculo)?.id ?? null : null;
  const r = db.prepare(`INSERT INTO movimientos (usuario_id,tipo,monto_centavos,moneda,tasa_a_base,categoria,nota,fecha,vehiculo_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(u.id, m.tipo, aCentavos(m.monto), moneda, t, m.categoria.toLowerCase(),
    m.nota ?? null, m.fecha ?? hoy(u.zona), vehiculoId);
  return { id: Number(r.lastInsertRowid), en_base: +(m.monto * t).toFixed(2), moneda_base: u.moneda_base, tasa: t };
}

export function resumenGastos(db: DB, u: Usuario, desde?: string | null, hasta?: string | null) {
  const h = hasta ?? hoy(u.zona);
  const d = desde ?? h.slice(0, 8) + "01";
  const filas = db.prepare(`SELECT tipo, categoria, sum(monto_centavos*tasa_a_base)/100.0 total, count(*) cantidad
    FROM movimientos WHERE usuario_id=? AND fecha BETWEEN ? AND ? GROUP BY tipo, categoria ORDER BY total DESC`)
    .all(u.id, d, h) as any[];
  const gastos = filas.filter((f) => f.tipo === "gasto");
  const ingresos = filas.filter((f) => f.tipo === "ingreso");
  const suma = (xs: any[]) => +xs.reduce((s, x) => s + x.total, 0).toFixed(2);
  return {
    desde: d, hasta: h, moneda: u.moneda_base,
    total_gastos: suma(gastos), total_ingresos: suma(ingresos),
    por_categoria: gastos.map((g) => ({ categoria: g.categoria, total: +g.total.toFixed(2), cantidad: g.cantidad })),
  };
}

export function ultimosMovimientos(db: DB, u: Usuario, limite = 10) {
  return db.prepare(`SELECT id,tipo,monto_centavos/100.0 monto,moneda,categoria,nota,fecha,
    round(monto_centavos*tasa_a_base/100.0,2) en_base FROM movimientos WHERE usuario_id=? ORDER BY fecha DESC, id DESC LIMIT ?`)
    .all(u.id, limite);
}

export function borrarMovimiento(db: DB, u: Usuario, id: number) {
  return db.prepare("DELETE FROM movimientos WHERE id=? AND usuario_id=?").run(id, u.id).changes > 0;
}

// ---------- Vencimientos (VenceYa) ----------
export function registrarVencimiento(db: DB, u: Usuario, v: {
  nombre: string; tipo: string; fecha: string; repetir?: string | null;
  monto?: number | null; moneda?: string | null; avisar_dias?: number[] | null; vehiculo?: string | null;
}) {
  verificarLimite(db, u, "vencimientos");
  const vehiculoId = v.vehiculo ? buscarVehiculo(db, u, v.vehiculo)?.id ?? null : null;
  const r = db.prepare(`INSERT INTO vencimientos (usuario_id,nombre,tipo,fecha,repetir,monto_centavos,moneda,avisar_dias,vehiculo_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(u.id, v.nombre, v.tipo, v.fecha, v.repetir ?? "nunca",
    v.monto != null ? aCentavos(v.monto) : null, v.moneda?.toUpperCase() ?? null,
    (v.avisar_dias?.length ? v.avisar_dias : [1, 0]).join(","), vehiculoId);
  return { id: Number(r.lastInsertRowid), faltan_dias: diasEntre(hoy(u.zona), v.fecha) };
}

export function proximosVencimientos(db: DB, u: Usuario, dias = 30) {
  const h = hoy(u.zona);
  return (db.prepare(`SELECT id,nombre,tipo,fecha,repetir,monto_centavos/100.0 monto,moneda FROM vencimientos
    WHERE usuario_id=? AND activo=1 AND fecha <= ? ORDER BY fecha`).all(u.id, sumarDias(h, dias)) as any[])
    .map((v) => ({ ...v, faltan_dias: diasEntre(h, v.fecha) }));
}

export function borrarVencimiento(db: DB, u: Usuario, id: number) {
  return db.prepare("UPDATE vencimientos SET activo=0 WHERE id=? AND usuario_id=?").run(id, u.id).changes > 0;
}

// ---------- Carro (MotorYa) ----------
export function buscarVehiculo(db: DB, u: Usuario, nombre: string) {
  const filas = db.prepare("SELECT * FROM vehiculos WHERE usuario_id=? ORDER BY id").all(u.id) as unknown as { id: number; nombre: string; km_actual: number | null }[];
  return porNombre(filas, nombre);
}

export function registrarVehiculo(db: DB, u: Usuario, nombre: string, km?: number | null) {
  verificarLimite(db, u, "vehiculos");
  const r = db.prepare("INSERT INTO vehiculos (usuario_id,nombre,km_actual) VALUES (?,?,?)").run(u.id, nombre, km ?? null);
  return { id: Number(r.lastInsertRowid) };
}

export function listarVehiculos(db: DB, u: Usuario) {
  return db.prepare("SELECT id,nombre,km_actual FROM vehiculos WHERE usuario_id=? ORDER BY id").all(u.id);
}

export function registrarMantenimiento(db: DB, u: Usuario, m: {
  vehiculo?: string | null; servicio: string; km?: number | null; fecha?: string | null;
  proximo_km?: number | null; proxima_fecha?: string | null;
}) {
  const veh = m.vehiculo ? buscarVehiculo(db, u, m.vehiculo)
    : db.prepare("SELECT * FROM vehiculos WHERE usuario_id=? ORDER BY id LIMIT 1").get(u.id) as any;
  if (!veh) throw new Error("No hay vehículo registrado. Primero registra uno.");
  if (m.km) db.prepare("UPDATE vehiculos SET km_actual=max(coalesce(km_actual,0),?) WHERE id=?").run(m.km, veh.id);
  const r = db.prepare(`INSERT INTO mantenimientos (usuario_id,vehiculo_id,servicio,fecha,km,proximo_km,proxima_fecha)
    VALUES (?,?,?,?,?,?,?)`).run(u.id, veh.id, m.servicio, m.fecha ?? hoy(u.zona), m.km ?? null, m.proximo_km ?? null, m.proxima_fecha ?? null);
  return { id: Number(r.lastInsertRowid), vehiculo: veh.nombre };
}

export function historialVehiculo(db: DB, u: Usuario, vehiculo?: string | null) {
  const veh = vehiculo ? buscarVehiculo(db, u, vehiculo)
    : db.prepare("SELECT * FROM vehiculos WHERE usuario_id=? ORDER BY id LIMIT 1").get(u.id) as any;
  if (!veh) return { error: "No hay vehículo registrado" };
  return {
    vehiculo: veh,
    mantenimientos: db.prepare("SELECT servicio,fecha,km,proximo_km,proxima_fecha FROM mantenimientos WHERE vehiculo_id=? ORDER BY fecha DESC LIMIT 10").all(veh.id),
    gastos_mes: n(db, "SELECT coalesce(sum(monto_centavos*tasa_a_base),0)/100.0 n FROM movimientos WHERE vehiculo_id=? AND substr(fecha,1,7)=?", veh.id, hoy(u.zona).slice(0, 7)),
  };
}

// ---------- Medicinas (DosisYa) ----------
export function registrarMedicina(db: DB, u: Usuario, m: {
  nombre: string; perfil?: string | null; dosis?: string | null; horas: string[]; quedan?: number | null; por_toma?: number | null;
}) {
  verificarLimite(db, u, "medicinas");
  const horas = m.horas.map((h) => h.padStart(5, "0")).sort().join(",");
  const r = db.prepare("INSERT INTO medicinas (usuario_id,perfil,nombre,dosis,horas,quedan,por_toma) VALUES (?,?,?,?,?,?,?)")
    .run(u.id, (m.perfil ?? "yo").toLowerCase(), m.nombre, m.dosis ?? null, horas, m.quedan ?? null, m.por_toma ?? 1);
  return { id: Number(r.lastInsertRowid), horas };
}

export function listarMedicinas(db: DB, u: Usuario) {
  return db.prepare("SELECT id,perfil,nombre,dosis,horas,quedan FROM medicinas WHERE usuario_id=? AND activo=1 ORDER BY perfil,nombre").all(u.id);
}

/** Marca como tomada la toma pendiente más reciente de esa medicina (o la de ahora). */
export function marcarToma(db: DB, u: Usuario, medicina: string, estado: "tomada" | "saltada" = "tomada") {
  const med = porNombre(db.prepare("SELECT * FROM medicinas WHERE usuario_id=? AND activo=1").all(u.id) as any[], medicina);
  if (!med) return { error: `No encuentro la medicina "${medicina}"` };
  const pend = db.prepare("SELECT id FROM tomas WHERE medicina_id=? AND estado='pendiente' ORDER BY programada DESC LIMIT 1").get(med.id) as any;
  if (pend) db.prepare("UPDATE tomas SET estado=?, marcada_at=datetime('now') WHERE id=?").run(estado, pend.id);
  else {
    const ahora = new Date().toISOString().slice(0, 16).replace("T", " ");
    db.prepare("INSERT OR IGNORE INTO tomas (medicina_id,programada,estado,marcada_at) VALUES (?,?,?,datetime('now'))").run(med.id, ahora, estado);
  }
  let quedan = med.quedan;
  if (estado === "tomada" && quedan != null) {
    quedan = Math.max(0, quedan - med.por_toma);
    db.prepare("UPDATE medicinas SET quedan=? WHERE id=?").run(quedan, med.id);
  }
  return { medicina: med.nombre, perfil: med.perfil, estado, quedan };
}

export function borrarMedicina(db: DB, u: Usuario, id: number) {
  return db.prepare("UPDATE medicinas SET activo=0 WHERE id=? AND usuario_id=?").run(id, u.id).changes > 0;
}

// ---------- Ajustes ----------
export function ajustar(db: DB, u: Usuario, a: { nombre?: string | null; moneda_base?: string | null; moneda_local?: string | null; zona?: string | null }) {
  if (a.zona) new Intl.DateTimeFormat("es", { timeZone: a.zona }); // lanza si la zona no existe
  db.prepare(`UPDATE usuarios SET nombre=coalesce(?,nombre), moneda_base=coalesce(?,moneda_base),
    moneda_local=coalesce(?,moneda_local), zona=coalesce(?,zona) WHERE id=?`)
    .run(a.nombre ?? null, a.moneda_base?.toUpperCase() ?? null, a.moneda_local?.toUpperCase() ?? null, a.zona ?? null, u.id);
  return { ok: true };
}
