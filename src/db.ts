// Base de datos local (SQLite incluido en Node 22). Un solo archivo: datos/asistente.db
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  telefono TEXT UNIQUE NOT NULL,
  nombre TEXT,
  moneda_base TEXT NOT NULL DEFAULT 'USD',
  moneda_local TEXT NOT NULL DEFAULT 'VES',
  zona TEXT NOT NULL DEFAULT 'America/Caracas',
  plan TEXT NOT NULL DEFAULT 'gratis',
  plan_hasta TEXT,
  ultimo_mensaje_at TEXT,
  creado_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DuoCash: gastos e ingresos en cualquier moneda, con la tasa del momento
CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('gasto','ingreso')),
  monto_centavos INTEGER NOT NULL,
  moneda TEXT NOT NULL,
  tasa_a_base REAL NOT NULL,           -- cuántas unidades de moneda base vale 1 unidad de "moneda"
  categoria TEXT NOT NULL,
  nota TEXT,
  fecha TEXT NOT NULL,                 -- AAAA-MM-DD en la zona del usuario
  vehiculo_id INTEGER REFERENCES vehiculos(id),
  creado_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- VenceYa: suscripciones, pagos fijos, documentos, garantías, seguros
CREATE TABLE IF NOT EXISTS vencimientos (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL,                  -- suscripcion, pago, documento, garantia, seguro, otro
  fecha TEXT NOT NULL,                 -- próxima fecha AAAA-MM-DD
  repetir TEXT NOT NULL DEFAULT 'nunca' CHECK (repetir IN ('nunca','semanal','mensual','anual')),
  monto_centavos INTEGER,
  moneda TEXT,
  avisar_dias TEXT NOT NULL DEFAULT '1,0', -- días antes de la fecha en que se avisa
  vehiculo_id INTEGER REFERENCES vehiculos(id),
  activo INTEGER NOT NULL DEFAULT 1,
  creado_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- MotorYa: vehículos, gasolina y mantenimiento
CREATE TABLE IF NOT EXISTS vehiculos (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  nombre TEXT NOT NULL,
  km_actual INTEGER,
  creado_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mantenimientos (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  vehiculo_id INTEGER NOT NULL REFERENCES vehiculos(id),
  servicio TEXT NOT NULL,              -- aceite, cauchos, frenos...
  fecha TEXT NOT NULL,
  km INTEGER,
  proximo_km INTEGER,
  proxima_fecha TEXT,
  movimiento_id INTEGER REFERENCES movimientos(id),
  creado_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DosisYa: perfiles, medicinas, tomas
CREATE TABLE IF NOT EXISTS medicinas (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  perfil TEXT NOT NULL DEFAULT 'yo',   -- para quién es (yo, mamá, hijo...)
  nombre TEXT NOT NULL,
  dosis TEXT,
  horas TEXT NOT NULL,                 -- "08:00,20:00"
  quedan INTEGER,                      -- unidades restantes, para avisar reposición
  por_toma INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tomas (
  id INTEGER PRIMARY KEY,
  medicina_id INTEGER NOT NULL REFERENCES medicinas(id),
  programada TEXT NOT NULL,            -- AAAA-MM-DD HH:MM local
  estado TEXT NOT NULL CHECK (estado IN ('pendiente','tomada','saltada')),
  marcada_at TEXT,
  UNIQUE (medicina_id, programada)
);

-- Historial corto del chat, para que la IA tenga contexto
CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  rol TEXT NOT NULL CHECK (rol IN ('user','assistant')),
  texto TEXT NOT NULL,
  creado_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Para no repetir el mismo aviso
CREATE TABLE IF NOT EXISTS avisos_enviados (
  clave TEXT PRIMARY KEY,
  enviado_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Enlaces de un solo uso para entrar al dashboard
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  expira_at TEXT NOT NULL
);

-- Mensajes de WhatsApp ya procesados (Meta a veces reenvía)
CREATE TABLE IF NOT EXISTS wa_recibidos (
  wa_id TEXT PRIMARY KEY,
  recibido_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function abrirDB(ruta = process.env.DB_RUTA ?? "datos/asistente.db"): DB {
  if (ruta !== ":memory:") mkdirSync(dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(ESQUEMA);
  return db;
}

export interface Usuario {
  id: number;
  telefono: string;
  nombre: string | null;
  moneda_base: string;
  moneda_local: string;
  zona: string;
  plan: string;
  plan_hasta: string | null;
  ultimo_mensaje_at: string | null;
}

export function usuarioPorTelefono(db: DB, telefono: string, nombre?: string): Usuario {
  db.prepare("INSERT OR IGNORE INTO usuarios (telefono, nombre) VALUES (?, ?)").run(telefono, nombre ?? null);
  return db.prepare("SELECT * FROM usuarios WHERE telefono = ?").get(telefono) as unknown as Usuario;
}

export function usuarioPorId(db: DB, id: number): Usuario | undefined {
  return db.prepare("SELECT * FROM usuarios WHERE id = ?").get(id) as unknown as Usuario | undefined;
}
