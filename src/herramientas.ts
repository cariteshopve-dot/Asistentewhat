// Herramientas que la IA puede usar para guardar y consultar datos del usuario.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { DB, Usuario } from "./db.ts";
import * as s from "./servicios.ts";
import { LimiteAlcanzado } from "./servicios.ts";

const MONEDAS = ["USD", "EUR", "USDT", "VES", "ARS", "COP", "DOP", "CLP", "UYU", "PEN"] as const;
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("AAAA-MM-DD");

function ejecutar(fn: () => unknown | Promise<unknown>) {
  return async () => {
    try {
      return JSON.stringify(await fn());
    } catch (e) {
      if (e instanceof LimiteAlcanzado) return JSON.stringify({ error: e.message, sugerir: "plan Pro" });
      return JSON.stringify({ error: (e as Error).message });
    }
  };
}

export function herramientas(db: DB, u: Usuario) {
  return [
    betaZodTool({
      name: "registrar_movimiento",
      description: "Guarda un gasto o un ingreso. Úsala cada vez que el usuario cuente que gastó, pagó, compró, cobró o recibió dinero. Si el gasto es del carro (gasolina, repuestos, taller), pasa el vehículo.",
      inputSchema: z.object({
        tipo: z.enum(["gasto", "ingreso"]),
        monto: z.number().positive(),
        moneda: z.enum(MONEDAS).describe("Si el usuario no la dice, usa su moneda habitual del contexto"),
        categoria: z.string().describe("Una palabra: comida, mercado, transporte, gasolina, salud, casa, servicios, ocio, ropa, educacion, carro, sueldo, otro..."),
        nota: z.string().nullable(),
        fecha: fecha.nullable().describe("Solo si no es hoy"),
        tasa_propia: z.number().positive().nullable().describe("Si el usuario dice a qué tasa cambió, en moneda local por 1 de moneda base"),
        vehiculo: z.string().nullable(),
      }),
      run: (i) => ejecutar(() => s.registrarMovimiento(db, u, i))(),
    }),
    betaZodTool({
      name: "resumen_gastos",
      description: "Totales de gastos e ingresos por categoría en la moneda base del usuario. Sin fechas = mes actual.",
      inputSchema: z.object({ desde: fecha.nullable(), hasta: fecha.nullable() }),
      run: (i) => ejecutar(() => s.resumenGastos(db, u, i.desde, i.hasta))(),
    }),
    betaZodTool({
      name: "ultimos_movimientos",
      description: "Lista los últimos gastos e ingresos con su id (para corregir o borrar).",
      inputSchema: z.object({ limite: z.number().int().min(1).max(30).nullable() }),
      run: (i) => ejecutar(() => s.ultimosMovimientos(db, u, i.limite ?? 10))(),
    }),
    betaZodTool({
      name: "borrar_movimiento",
      description: "Borra un gasto o ingreso por id. Solo cuando el usuario pide borrar o corregir uno.",
      inputSchema: z.object({ id: z.number().int() }),
      run: (i) => ejecutar(() => ({ borrado: s.borrarMovimiento(db, u, i.id) }))(),
    }),
    betaZodTool({
      name: "registrar_vencimiento",
      description: "Guarda algo que vence o se paga en una fecha: suscripción (Netflix, Spotify), pago fijo (alquiler, internet), documento (cédula, pasaporte, licencia), garantía, seguro. Para fechas del carro (seguro, revisión) pasa el vehículo.",
      inputSchema: z.object({
        nombre: z.string(),
        tipo: z.enum(["suscripcion", "pago", "documento", "garantia", "seguro", "otro"]),
        fecha: fecha.describe("Próxima fecha. 'cada 5' = el próximo día 5"),
        repetir: z.enum(["nunca", "semanal", "mensual", "anual"]).nullable(),
        monto: z.number().positive().nullable(),
        moneda: z.enum(MONEDAS).nullable(),
        avisar_dias: z.array(z.number().int().min(0).max(90)).nullable().describe("Días antes en que avisar. Por defecto [1,0]"),
        vehiculo: z.string().nullable(),
      }),
      run: (i) => ejecutar(() => s.registrarVencimiento(db, u, i))(),
    }),
    betaZodTool({
      name: "proximos_vencimientos",
      description: "Lista lo que vence en los próximos días (incluye lo ya vencido).",
      inputSchema: z.object({ dias: z.number().int().min(1).max(365).nullable() }),
      run: (i) => ejecutar(() => s.proximosVencimientos(db, u, i.dias ?? 30))(),
    }),
    betaZodTool({
      name: "borrar_vencimiento",
      description: "Desactiva un vencimiento por id (ej. el usuario canceló la suscripción).",
      inputSchema: z.object({ id: z.number().int() }),
      run: (i) => ejecutar(() => ({ borrado: s.borrarVencimiento(db, u, i.id) }))(),
    }),
    betaZodTool({
      name: "registrar_vehiculo",
      description: "Agrega un vehículo del usuario (ej. 'Corolla 2015', 'la moto').",
      inputSchema: z.object({ nombre: z.string(), km: z.number().int().nullable() }),
      run: (i) => ejecutar(() => s.registrarVehiculo(db, u, i.nombre, i.km))(),
    }),
    betaZodTool({
      name: "registrar_mantenimiento",
      description: "Guarda un servicio del carro: cambio de aceite, cauchos, frenos, batería, etc. Si costó dinero, además usa registrar_movimiento con categoria 'carro'.",
      inputSchema: z.object({
        vehiculo: z.string().nullable(), servicio: z.string(), km: z.number().int().nullable(), fecha: fecha.nullable(),
        proximo_km: z.number().int().nullable(), proxima_fecha: fecha.nullable(),
      }),
      run: (i) => ejecutar(() => s.registrarMantenimiento(db, u, i))(),
    }),
    betaZodTool({
      name: "historial_vehiculo",
      description: "Kilometraje, últimos mantenimientos y gasto del mes de un vehículo.",
      inputSchema: z.object({ vehiculo: z.string().nullable() }),
      run: (i) => ejecutar(() => s.historialVehiculo(db, u, i.vehiculo))(),
    }),
    betaZodTool({
      name: "registrar_medicina",
      description: "Guarda una medicina con sus horas de toma diarias, para quién es y cuántas quedan.",
      inputSchema: z.object({
        nombre: z.string(), perfil: z.string().nullable().describe("Para quién: yo, mamá, papá, hijo..."),
        dosis: z.string().nullable(), horas: z.array(z.string().regex(/^\d{1,2}:\d{2}$/)).min(1).describe("Formato 24h, ej. ['08:00','20:00']"),
        quedan: z.number().int().nullable(), por_toma: z.number().int().positive().nullable(),
      }),
      run: (i) => ejecutar(() => s.registrarMedicina(db, u, i))(),
    }),
    betaZodTool({
      name: "marcar_toma",
      description: "Marca que el usuario tomó (o saltó) una medicina, ej. cuando responde 'listo', 'ya la tomé'.",
      inputSchema: z.object({ medicina: z.string(), estado: z.enum(["tomada", "saltada"]).nullable() }),
      run: (i) => ejecutar(() => s.marcarToma(db, u, i.medicina, i.estado ?? "tomada"))(),
    }),
    betaZodTool({
      name: "listar_medicinas",
      description: "Medicinas activas, con horas y cuántas quedan.",
      inputSchema: z.object({}),
      run: () => ejecutar(() => s.listarMedicinas(db, u))(),
    }),
    betaZodTool({
      name: "borrar_medicina",
      description: "Desactiva una medicina por id (terminó el tratamiento).",
      inputSchema: z.object({ id: z.number().int() }),
      run: (i) => ejecutar(() => ({ borrado: s.borrarMedicina(db, u, i.id) }))(),
    }),
    betaZodTool({
      name: "ajustes",
      description: "Cambia nombre, moneda base (en la que ve los totales), moneda local o zona horaria (IANA, ej. America/Bogota).",
      inputSchema: z.object({
        nombre: z.string().nullable(), moneda_base: z.enum(MONEDAS).nullable(),
        moneda_local: z.enum(MONEDAS).nullable(), zona: z.string().nullable(),
      }),
      run: (i) => ejecutar(() => s.ajustar(db, u, i))(),
    }),
  ];
}
