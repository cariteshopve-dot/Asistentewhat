// Revisa cada pocos minutos qué hay que avisar a cada usuario.
import type { DB, Usuario } from "./db.ts";
import { partesLocales, sumarDias, siguienteFecha, diasEntre } from "./fechas.ts";
import { resumenGastos, proximosVencimientos } from "./servicios.ts";

export type Enviar = (u: Usuario, texto: string) => Promise<void>;

const HORA_AVISOS = process.env.HORA_AVISOS ?? "09:00";
const HORA_RESUMEN = "19:00";

/** Devuelve true solo la primera vez que se pide una clave. */
function primeraVez(db: DB, clave: string) {
  return db.prepare("INSERT OR IGNORE INTO avisos_enviados (clave) VALUES (?)").run(clave).changes > 0;
}

async function avisar(db: DB, enviar: Enviar, u: Usuario, clave: string, texto: string) {
  if (!primeraVez(db, clave)) return;
  try { await enviar(u, texto); }
  catch (e) {
    db.prepare("DELETE FROM avisos_enviados WHERE clave=?").run(clave); // se reintenta en la próxima vuelta
    console.error("aviso fallido", clave, (e as Error).message);
  }
}

const cuando = (d: number) => d === 0 ? "*hoy*" : d === 1 ? "*mañana*" : `en *${d} días*`;
const plata = (monto: number | null, moneda: string | null) => monto ? ` (${monto} ${moneda ?? ""})`.replace(" )", ")") : "";

export async function revisarAvisos(db: DB, enviar: Enviar, ahora = new Date()) {
  const usuarios = db.prepare("SELECT * FROM usuarios").all() as unknown as Usuario[];
  for (const u of usuarios) {
    const { fecha: hoy, hora } = partesLocales(u.zona, ahora);

    // 1. Vencimientos repetitivos que ya pasaron: mover a la próxima fecha
    for (const v of db.prepare("SELECT * FROM vencimientos WHERE usuario_id=? AND activo=1 AND repetir!='nunca' AND fecha<?").all(u.id, hoy) as any[]) {
      let f = v.fecha;
      while (f < hoy) f = siguienteFecha(f, v.repetir)!;
      db.prepare("UPDATE vencimientos SET fecha=? WHERE id=?").run(f, v.id);
    }

    if (hora >= HORA_AVISOS) {
      // 2. Vencimientos: avisar X días antes
      for (const v of db.prepare("SELECT * FROM vencimientos WHERE usuario_id=? AND activo=1 AND fecha>=?").all(u.id, hoy) as any[]) {
        const faltan = diasEntre(hoy, v.fecha);
        const dias = String(v.avisar_dias).split(",").map(Number);
        if (dias.includes(faltan)) {
          await avisar(db, enviar, u, `v:${v.id}:${v.fecha}:${faltan}`,
            `⏰ ${v.nombre}${plata(v.monto_centavos && v.monto_centavos / 100, v.moneda)} vence ${cuando(faltan)} (${v.fecha}).`);
        }
      }
      // 3. Mantenimiento del carro por fecha
      for (const m of db.prepare(`SELECT m.*, ve.nombre vehiculo FROM mantenimientos m JOIN vehiculos ve ON ve.id=m.vehiculo_id
          WHERE m.usuario_id=? AND m.proxima_fecha IS NOT NULL AND m.proxima_fecha>=?`).all(u.id, hoy) as any[]) {
        const faltan = diasEntre(hoy, m.proxima_fecha);
        if (faltan === 7 || faltan === 0) {
          await avisar(db, enviar, u, `mf:${m.id}:${faltan}`, `🚗 ${m.vehiculo}: toca ${m.servicio} ${cuando(faltan)}.`);
        }
      }
      // 4. Mantenimiento por kilometraje (aviso cuando faltan 500 km o menos)
      for (const m of db.prepare(`SELECT m.*, ve.nombre vehiculo, ve.km_actual FROM mantenimientos m JOIN vehiculos ve ON ve.id=m.vehiculo_id
          WHERE m.usuario_id=? AND m.proximo_km IS NOT NULL AND ve.km_actual IS NOT NULL AND ve.km_actual >= m.proximo_km - 500
          AND m.id = (SELECT max(id) FROM mantenimientos x WHERE x.vehiculo_id=m.vehiculo_id AND x.servicio=m.servicio)`).all(u.id) as any[]) {
        await avisar(db, enviar, u, `mk:${m.id}`,
          `🚗 ${m.vehiculo}: el ${m.servicio} toca a los ${m.proximo_km} km y vas por ${m.km_actual} km.`);
      }
    }

    // 5. Medicinas: aviso a cada hora de toma (hasta 60 min tarde, por si el servidor estuvo apagado)
    for (const med of db.prepare("SELECT * FROM medicinas WHERE usuario_id=? AND activo=1").all(u.id) as any[]) {
      for (const h of String(med.horas).split(",")) {
        const retraso = minutos(hora) - minutos(h);
        if (retraso < 0 || retraso > 60) continue;
        const programada = `${hoy} ${h}`;
        const nueva = db.prepare("INSERT OR IGNORE INTO tomas (medicina_id, programada, estado) VALUES (?,?,'pendiente')").run(med.id, programada).changes > 0;
        if (!nueva) continue;
        const para = med.perfil === "yo" ? "" : ` de *${med.perfil}*`;
        await avisar(db, enviar, u, `m:${med.id}:${programada}`,
          `💊 Hora de ${med.nombre}${med.dosis ? " " + med.dosis : ""}${para}. Responde *listo* cuando la tomes.`);
      }
      // Reposición: quedan para 3 días o menos
      const porDia = String(med.horas).split(",").length * med.por_toma;
      if (med.quedan != null && med.quedan <= porDia * 3 && hora >= HORA_AVISOS) {
        await avisar(db, enviar, u, `r:${med.id}:${hoy}`,
          `🛒 Quedan ${med.quedan} de ${med.nombre}${med.perfil === "yo" ? "" : ` (${med.perfil})`}. Toca comprar pronto.`);
      }
    }

    // 6. Resumen semanal: domingo en la noche
    const domingo = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: u.zona }).format(ahora) === "Sun";
    if (domingo && hora >= HORA_RESUMEN) {
      const g = resumenGastos(db, u, sumarDias(hoy, -6), hoy);
      const prox = proximosVencimientos(db, u, 7).filter((v) => v.faltan_dias >= 0);
      if (g.total_gastos || prox.length) {
        const top = g.por_categoria.slice(0, 3).map((c) => `${c.categoria} ${c.total}`).join(", ");
        const lineas = [`📊 *Tu semana*: gastaste ${g.total_gastos} ${g.moneda}${top ? ` (${top})` : ""}.`];
        if (prox.length) lineas.push(`Esta semana vence: ${prox.map((v) => `${v.nombre} (${v.fecha.slice(5)})`).join(", ")}.`);
        lineas.push(`Escribe *panel* para ver todo.`);
        await avisar(db, enviar, u, `s:${u.id}:${hoy}`, lineas.join("\n"));
      }
    }
  }
}

const minutos = (h: string) => { const [a, b] = h.split(":").map(Number); return a * 60 + b; };
