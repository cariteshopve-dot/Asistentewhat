// Tasas de cambio. Todas expresadas como: 1 unidad de la moneda = X USD.
const CACHE_MS = 60 * 60 * 1000;
let cache: { at: number; usd: Record<string, number> } | null = null;

async function json(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/** Unidades de cada moneda por 1 USD. */
async function porDolar(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.usd;
  const usd: Record<string, number> = { USD: 1, USDT: 1 };
  try {
    const er = await json("https://open.er-api.com/v6/latest/USD");
    Object.assign(usd, er.rates);
  } catch (e) { console.warn("tasas er-api:", (e as Error).message); }
  try {
    // Venezuela: tasa oficial BCV
    const bcv = await json("https://ve.dolarapi.com/v1/dolares/oficial");
    if (bcv?.promedio) usd.VES = bcv.promedio;
  } catch (e) { console.warn("tasas dolarapi:", (e as Error).message); }
  usd.USD = 1; usd.USDT = 1;
  cache = { at: Date.now(), usd };
  return usd;
}

/** Cuánto vale 1 unidad de `de` en la moneda `a`. */
export async function tasa(de: string, a: string): Promise<number> {
  if (de === a) return 1;
  const usd = await porDolar();
  if (!usd[de] || !usd[a]) throw new Error(`No tengo tasa para ${de} -> ${a}`);
  return usd[a] / usd[de];
}

/** Solo para pruebas */
export function fijarTasasDePrueba(usd: Record<string, number>) {
  cache = { at: Date.now(), usd: { USD: 1, USDT: 1, ...usd } };
}
