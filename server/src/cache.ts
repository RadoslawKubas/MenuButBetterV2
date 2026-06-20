// Serwerowy cache TREŚCI (zdjęcia poglądowe / opisy dań / werdykty vision) — żeby NIE płacić
// drugi raz za to samo. Wzorzec BEST‑EFFORT jak db.ts: bez DATABASE_URL cache jest no‑opem,
// a pipeline działa normalnie (po prostu liczy od nowa). Dwa poziomy: L1 = LRU w pamięci
// (szybkie, per proces), L2 = Postgres (przeżywa redeploy, współdzielone między instancjami).
//
// Klucz NIESIE WERSJĘ (CACHE_VERSION[kind]) — zmiana promptu/progu/pipeline’u = bump wersji →
// stary cache automatycznie omijany, nigdy nie poda starego, gorszego wyniku po ulepszeniu.
import { getPool } from "./db.ts";
import { recordCacheHit } from "./apiLog.ts";

let ready = false;

/** Wersje per rodzaj — BUMP gdy zmieni się prompt/model/próg, by unieważnić stare wpisy. */
export const CACHE_VERSION = {
  "repr-photos": 1, // zdjęcia poglądowe „typ dania" (lista zweryfikowanych URL)
  "dish-info": 1, // opis dania (tekst)
  "vision-url": 1, // werdykt vision dla pojedynczego (termin,URL)
} as const;
export type CacheKind = keyof typeof CACHE_VERSION;

/** Domyślny TTL (dni) per rodzaj. Zdjęcia gniją (URL-e) → krócej; tekst → długo. */
const TTL_DAYS: Record<CacheKind, number> = {
  "repr-photos": 45,
  "dish-info": 200,
  "vision-url": 45,
};

const DISABLED = process.env.CACHE_DISABLED === "1";

/** Tworzy tabelę cache (idempotentnie). Wołane na starcie serwera. */
export async function initCache(): Promise<void> {
  if (DISABLED) {
    console.log("[cache] CACHE_DISABLED=1 — cache treści WYŁĄCZONY.");
    return;
  }
  const p = getPool();
  if (!p) {
    console.log("[cache] DATABASE_URL brak — cache treści w pamięci (L1), bez trwałości.");
    ready = false;
    return;
  }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS content_cache (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        lang TEXT,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ,
        hits INTEGER NOT NULL DEFAULT 0,
        last_hit TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS content_cache_kind_idx ON content_cache (kind);
      CREATE INDEX IF NOT EXISTS content_cache_expires_idx ON content_cache (expires_at);
    `);
    ready = true;
    console.log("[cache] cache treści GOTOWY (Postgres + LRU).");
  } catch (e) {
    console.error("[cache] init nieudany — cache tylko w pamięci:", (e as Error).message);
    ready = false;
  }
}

// --- Normalizacja klucza -----------------------------------------------------------------
function deaccentLower(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
/** Składa znormalizowane części w klucz (deakcent+lower+trim+zwężenie spacji). Puste pomijane. */
export function cacheKey(kind: CacheKind, ...parts: (string | number | boolean | undefined | null)[]): string {
  const norm = parts
    .map((x) => (x == null || x === "" ? "" : deaccentLower(String(x)).replace(/\s+/g, " ").trim()))
    .join("|");
  return `${kind}:v${CACHE_VERSION[kind]}:${norm}`;
}

// --- L1: LRU w pamięci -------------------------------------------------------------------
interface L1Entry { value: unknown; exp: number }
const L1 = new Map<string, L1Entry>();
const L1_MAX = 2000;
function l1Get(key: string): unknown | undefined {
  const e = L1.get(key);
  if (!e) return undefined;
  if (e.exp && e.exp < Date.now()) { L1.delete(key); return undefined; }
  L1.delete(key); L1.set(key, e); // odśwież pozycję (LRU)
  return e.value;
}
function l1Set(key: string, value: unknown, exp: number): void {
  L1.set(key, { value, exp });
  if (L1.size > L1_MAX) { const first = L1.keys().next().value; if (first) L1.delete(first); }
}

// --- API ---------------------------------------------------------------------------------
export interface CacheGetOpts { op?: string; bypass?: boolean }

/**
 * Pobiera wartość z cache (L1→L2). Trafienie = zapis zdarzenia „cache hit" (do statystyk
 * oszczędności) i bump licznika hits. Zwraca null przy pudle / wyłączeniu / bypass.
 */
export async function cacheGet<T>(kind: CacheKind, key: string, opts?: CacheGetOpts): Promise<T | null> {
  if (DISABLED || opts?.bypass) return null;
  const l1 = l1Get(key);
  if (l1 !== undefined) { recordCacheHit(opts?.op ?? kind); return l1 as T; }
  const p = getPool();
  if (!p || !ready) return null;
  try {
    const r = await p.query(
      `UPDATE content_cache SET hits = hits + 1, last_hit = now()
       WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())
       RETURNING value`,
      [key],
    );
    if (!r.rows.length) return null;
    const value = r.rows[0].value as T;
    // odłóż do L1 z TTL ~ rodzaju (przybliżenie — i tak L2 jest źródłem prawdy)
    l1Set(key, value, Date.now() + TTL_DAYS[kind] * 86400_000);
    recordCacheHit(opts?.op ?? kind);
    return value;
  } catch (e) {
    console.error("[cache] get:", (e as Error).message);
    return null;
  }
}

export interface CacheSetOpts { ttlDays?: number; lang?: string }

/** Zapisuje wartość (L1 + L2, best‑effort). No‑op bez DB poza L1. */
export async function cacheSet(kind: CacheKind, key: string, value: unknown, opts?: CacheSetOpts): Promise<void> {
  if (DISABLED) return;
  const ttl = opts?.ttlDays ?? TTL_DAYS[kind];
  l1Set(key, value, Date.now() + ttl * 86400_000);
  const p = getPool();
  if (!p || !ready) return;
  p.query(
    `INSERT INTO content_cache (key, kind, lang, value, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, lang = EXCLUDED.lang,
       created_at = now(), expires_at = EXCLUDED.expires_at, hits = 0, last_hit = NULL`,
    [key, kind, opts?.lang ?? null, JSON.stringify(value), String(ttl)],
  ).catch((e) => console.error("[cache] set:", (e as Error).message));
}

/** Usuwa wpis (np. gdy URL zdjęcia okazał się martwy → wymusza świeże szukanie). */
export async function cacheDelete(key: string): Promise<void> {
  L1.delete(key);
  const p = getPool();
  if (!p || !ready) return;
  p.query(`DELETE FROM content_cache WHERE key = $1`, [key]).catch((e) => console.error("[cache] del:", (e as Error).message));
}

export interface CacheStatRow { kind: string; entries: number; hits: number; lang?: string | null }

/** Statystyki do podglądu w LABie (ile wpisów / trafień per rodzaj). */
export async function cacheStats(): Promise<{ enabled: boolean; l1: number; rows: CacheStatRow[] }> {
  const p = getPool();
  if (!p || !ready) return { enabled: false, l1: L1.size, rows: [] };
  try {
    const r = await p.query(
      `SELECT kind, count(*)::int AS entries, coalesce(sum(hits),0)::int AS hits
       FROM content_cache WHERE expires_at IS NULL OR expires_at > now()
       GROUP BY kind ORDER BY hits DESC`,
    );
    return { enabled: true, l1: L1.size, rows: r.rows.map((x) => ({ kind: x.kind, entries: x.entries, hits: x.hits })) };
  } catch {
    return { enabled: false, l1: L1.size, rows: [] };
  }
}

/** Czyści cache (cały lub jednego rodzaju). Do przycisku „wyczyść" w LABie. */
export async function cacheClear(kind?: CacheKind): Promise<void> {
  L1.clear();
  const p = getPool();
  if (!p || !ready) return;
  if (kind) await p.query(`DELETE FROM content_cache WHERE kind = $1`, [kind]).catch(() => {});
  else await p.query(`DELETE FROM content_cache`).catch(() => {});
}
