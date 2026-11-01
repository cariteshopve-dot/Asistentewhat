// Fechas en la zona horaria de cada usuario (por defecto Caracas)

export function partesLocales(zona: string, d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

export const hoy = (zona: string, d?: Date) => partesLocales(zona, d).fecha;

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(hasta + "T12:00:00Z") - Date.parse(desde + "T12:00:00Z")) / 86_400_000);
}

/** Siguiente fecha de un vencimiento que se repite. Mensual respeta fin de mes (31 ene -> 28/29 feb). */
export function siguienteFecha(fecha: string, repetir: string): string | null {
  if (repetir === "semanal") return sumarDias(fecha, 7);
  if (repetir === "mensual" || repetir === "anual") {
    const [a, m, d] = fecha.split("-").map(Number);
    const meses = repetir === "mensual" ? 1 : 12;
    const total = (m - 1) + meses;
    const na = a + Math.floor(total / 12), nm = (total % 12) + 1;
    const ultimo = new Date(Date.UTC(na, nm, 0)).getUTCDate();
    return `${na}-${String(nm).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
  }
  return null;
}
