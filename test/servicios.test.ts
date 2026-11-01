import { test } from "node:test";
import assert from "node:assert/strict";
import { abrirDB, usuarioPorTelefono } from "../src/db.ts";
import * as s from "../src/servicios.ts";
import { fijarTasasDePrueba } from "../src/tasas.ts";
import { siguienteFecha, hoy, sumarDias } from "../src/fechas.ts";
import { revisarAvisos } from "../src/avisos.ts";
import { extraerMensajes, firmaValida, dentroDeVentana } from "../src/whatsapp.ts";
import { aplicarEventoLemon } from "../src/pagos.ts";
import { crearEnlace, canjearEnlace, usuarioDeSesion, paginaPanel } from "../src/dashboard.ts";
import { createHmac } from "node:crypto";

fijarTasasDePrueba({ VES: 40, EUR: 0.9 });
const nueva = () => { const db = abrirDB(":memory:"); return { db, u: usuarioPorTelefono(db, "584121234567", "Ana") }; };

test("gasto en bolívares se guarda con la tasa del día y suma en dólares", async () => {
  const { db, u } = nueva();
  const r = await s.registrarMovimiento(db, u, { tipo: "gasto", monto: 400, moneda: "VES", categoria: "Mercado" });
  assert.equal(r.en_base, 10);
  await s.registrarMovimiento(db, u, { tipo: "gasto", monto: 5, moneda: "USD", categoria: "mercado" });
  await s.registrarMovimiento(db, u, { tipo: "ingreso", monto: 100, moneda: "USD", categoria: "sueldo" });
  const res = s.resumenGastos(db, u);
  assert.equal(res.total_gastos, 15);
  assert.equal(res.total_ingresos, 100);
  assert.deepEqual(res.por_categoria, [{ categoria: "mercado", total: 15, cantidad: 2 }]);
});

test("tasa propia: 400 Bs a 50 por dólar = 8 USD", async () => {
  const { db, u } = nueva();
  const r = await s.registrarMovimiento(db, u, { tipo: "gasto", monto: 400, moneda: "VES", categoria: "comida", tasa_propia: 50 });
  assert.equal(r.en_base, 8);
});

test("límite del plan gratis en vehículos y Pro sin límite", () => {
  const { db, u } = nueva();
  s.registrarVehiculo(db, u, "Corolla");
  assert.throws(() => s.registrarVehiculo(db, u, "Moto"), s.LimiteAlcanzado);
  db.prepare("UPDATE usuarios SET plan='pro' WHERE id=?").run(u.id);
  const pro = usuarioPorTelefono(db, u.telefono);
  assert.doesNotThrow(() => s.registrarVehiculo(db, pro, "Moto"));
});

test("fechas mensuales respetan fin de mes", () => {
  assert.equal(siguienteFecha("2026-01-31", "mensual"), "2026-02-28");
  assert.equal(siguienteFecha("2026-12-15", "mensual"), "2027-01-15");
  assert.equal(siguienteFecha("2028-02-29", "anual"), "2029-02-28");
  assert.equal(siguienteFecha("2026-11-01", "semanal"), "2026-11-08");
});

test("avisos de vencimiento: mañana y hoy, sin repetir", async () => {
  const { db, u } = nueva();
  const ahora = new Date("2026-11-10T14:00:00Z"); // 10:00 en Caracas
  s.registrarVencimiento(db, u, { nombre: "Netflix", tipo: "suscripcion", fecha: "2026-11-11", repetir: "mensual", monto: 9.99, moneda: "USD" });
  const enviados: string[] = [];
  const enviar = async (_: unknown, t: string) => { enviados.push(t); };
  await revisarAvisos(db, enviar, ahora);
  await revisarAvisos(db, enviar, ahora);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /Netflix.*mañana/);
  // Pasado el vencimiento, la suscripción salta al mes siguiente
  await revisarAvisos(db, enviar, new Date("2026-11-12T14:00:00Z"));
  assert.equal((db.prepare("SELECT fecha FROM vencimientos").get() as any).fecha, "2026-12-11");
});

test("medicina: aviso a la hora, 'listo' la marca y descuenta", async () => {
  const { db, u } = nueva();
  s.registrarMedicina(db, u, { nombre: "Losartán", perfil: "Mamá", horas: ["8:00", "20:00"], quedan: 10 });
  const enviados: string[] = [];
  await revisarAvisos(db, async (_, t) => { enviados.push(t); }, new Date("2026-11-10T12:05:00Z")); // 08:05 Caracas
  assert.ok(enviados.some((t) => /Losartán.*mamá/.test(t)));
  const r = s.marcarToma(db, u, "losartan");
  assert.equal(r.quedan, 9);
  assert.equal((db.prepare("SELECT estado FROM tomas").get() as any).estado, "tomada");
});

test("aviso de reposición cuando quedan pocas", async () => {
  const { db, u } = nueva();
  s.registrarMedicina(db, u, { nombre: "Metformina", horas: ["08:00", "20:00"], quedan: 4 });
  const enviados: string[] = [];
  await revisarAvisos(db, async (_, t) => { enviados.push(t); }, new Date("2026-11-10T15:00:00Z"));
  assert.ok(enviados.some((t) => /Quedan 4 de Metformina/.test(t)));
});

test("mantenimiento por kilometraje avisa al acercarse", async () => {
  const { db, u } = nueva();
  s.registrarVehiculo(db, u, "Corolla", 80000);
  s.registrarMantenimiento(db, u, { servicio: "cambio de aceite", km: 80000, proximo_km: 85000 });
  const enviados: string[] = [];
  const enviar = async (_: unknown, t: string) => { enviados.push(t); };
  await revisarAvisos(db, enviar, new Date("2026-11-10T14:00:00Z"));
  assert.equal(enviados.length, 0);
  db.prepare("UPDATE vehiculos SET km_actual=84600").run();
  await revisarAvisos(db, enviar, new Date("2026-11-10T14:00:00Z"));
  assert.match(enviados[0], /aceite.*85000/);
});

test("lee mensajes del webhook de Meta y verifica la firma", () => {
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: "58412", profile: { name: "Ana" } }],
    messages: [{ id: "wamid.1", from: "58412", type: "text", text: { body: "gasté 5" } }],
  } }] }] };
  assert.deepEqual(extraerMensajes(payload), [{ waId: "wamid.1", de: "58412", nombre: "Ana", tipo: "text", texto: "gasté 5" }]);
  const cuerpo = Buffer.from(JSON.stringify(payload));
  const firma = "sha256=" + createHmac("sha256", "clave").update(cuerpo).digest("hex");
  assert.equal(firmaValida(cuerpo, firma, "clave"), true);
  assert.equal(firmaValida(cuerpo, firma, "otra"), false);
});

test("ventana de 24 horas", () => {
  const base = { ultimo_mensaje_at: "2026-11-10 10:00:00" } as any;
  assert.equal(dentroDeVentana(base, Date.parse("2026-11-10T20:00:00Z")), true);
  assert.equal(dentroDeVentana(base, Date.parse("2026-11-11T11:00:00Z")), false);
});

test("pago de Lemon Squeezy activa Pro", () => {
  const { db, u } = nueva();
  aplicarEventoLemon(db, { meta: { event_name: "subscription_created", custom_data: { telefono: u.telefono } },
    data: { attributes: { status: "active", renews_at: "2026-12-10T00:00:00Z" } } });
  const p = usuarioPorTelefono(db, u.telefono);
  assert.equal(p.plan, "pro");
  assert.equal(p.plan_hasta, "2026-12-10");
});

test("enlace del panel sirve una sola vez y muestra los datos", async () => {
  const { db, u } = nueva();
  await s.registrarMovimiento(db, u, { tipo: "gasto", monto: 12, moneda: "USD", categoria: "comida" });
  const t = new URL(crearEnlace(db, u)).searchParams.get("t")!;
  const sesion = canjearEnlace(db, t)!;
  assert.ok(sesion);
  assert.equal(canjearEnlace(db, t), null);
  assert.equal(usuarioDeSesion(db, sesion)?.id, u.id);
  const html = paginaPanel(db, u);
  assert.match(html, /comida/);
  assert.match(html, /Hola, Ana/);
});
