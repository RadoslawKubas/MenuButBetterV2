// Serwerowy cache TREŚCI (zdjęcia poglądowe / opisy dań / werdykty vision) — żeby NIE płacić
// drugi raz za to samo. Wzorzec BEST‑EFFORT jak db.ts: bez DATABASE_URL cache jest no‑opem,
// a pipeline działa normalnie (po prostu liczy od nowa). Dwa poziomy: L1 = LRU w pamięci
// (szybkie, per proces), L2 = Postgres (przeżywa redeploy, współdzielone między instancjami).
//
// Klucz NIESIE WERSJĘ (CACHE_VERSION[kind]) — zmiana promptu/progu/pipeline’u = bump wersji →
// stary cache automatycznie omijany, nigdy nie poda starego, gorszego wyniku po ulepszeniu.
import { getPool, reqContext } from "./db.ts";
import { recordCacheHit } from "./apiLog.ts";
import { cacheReadEnabled, cacheTtlOverride } from "./runtimeConfig.ts";

let ready = false;

/** Wersje per rodzaj — BUMP gdy zmieni się prompt/model/próg, by unieważnić stare wpisy. */
// Przegląd promptów [2026-06]: temp 0 w skanie, konsolidacja nachodzących/wielojęzycznych fragmentów,
// warianty/ceny, photo_query „podana potrawa", krótszy opis, verify „pojedyncza porcja", dish-info regionalny.
// Zmiana promptów = bump wszystkich dotkniętych wersji, by stare wpisy nie zasłaniały nowego zachowania.
export const CACHE_VERSION = {
  // MODEL usunięty ZE WSZYSTKICH kluczy (jest teraz osobną kolumną-metadaną `model`, referencyjną, nie w kluczu).
  "repr-photos": 9, // zdjęcia poglądowe „typ dania" (v9: klucz po full_name + normalizacja BEZ sortu słów)
  "dish-info": 7, // opis dania (v7: bez modelu w kluczu = danie+kuchnia+kraj+region+język)
  "vision-url": 5, // werdykt vision (v5: instrukcja odrzuca okładki/skany książek + ciemne kadry bez potrawy)
  "menu-structure": 13, // przebieg 1: struktura menu (v13: UPROSZCZONY prompt — pola WIERNE KARCIE vs USTALANE z kontekstu; full_name z działu/sąsiadów/kuchni/adnotacji)
  "item-enrich": 9, // przebieg 2: WYŁĄCZNIE generyczna wiedza (v9: klucz po full_name; tłumaczenia przeniesione do skanu)
  "venue-match": 2, // Tier 0: dopasowanie zdjęć lokalu (v2: bez modelu w kluczu = hash zdjęć|hash dań|kuchnia|pewność)
  "bad-photo": 1, // zdjęcia odrzucone (za słaba jakość) — sam hash zdjęcia (modelu nigdy nie miał)
} as const;
export type CacheKind = keyof typeof CACHE_VERSION;

/** Domyślny TTL (dni) per rodzaj. Zdjęcia gniją (URL-e) → krócej; tekst/menu → długo. Nadpisywalny z LABu
 *  (config.cacheTtl per rodzaj) — patrz cacheTtlOverride. Eksport, by LAB pokazał domyślne. */
export const TTL_DAYS: Record<CacheKind, number> = {
  "repr-photos": 45,
  "dish-info": 200,
  "vision-url": 45,
  "menu-structure": 120,
  "item-enrich": 200,
  "venue-match": 30, // zdjęcia lokalu (URL-e Google) z czasem rotują → krócej; klucz po zdjęciach i tak chroni
  "bad-photo": 365, // złe zdjęcie raczej nie „naprawi się" samo — pamiętaj długo
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
        model TEXT,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ,
        hits INTEGER NOT NULL DEFAULT 0,
        last_hit TIMESTAMPTZ
      );
      ALTER TABLE content_cache ADD COLUMN IF NOT EXISTS model TEXT;
      CREATE INDEX IF NOT EXISTS content_cache_kind_idx ON content_cache (kind);
      CREATE INDEX IF NOT EXISTS content_cache_expires_idx ON content_cache (expires_at);
    `);
    ready = true;
    console.log("[cache] cache treści GOTOWY (Postgres + LRU).");
    // Sprzątanie: usuń WYGASŁE wpisy (były tylko pomijane przy odczycie → rosły bez końca). Best-effort.
    p.query(`DELETE FROM content_cache WHERE expires_at IS NOT NULL AND expires_at < now()`)
      .then((r) => { if (r.rowCount) console.log(`[cache] usunięto ${r.rowCount} wygasłych wpisów.`); })
      .catch((e) => console.error("[cache] czyszczenie wygasłych nieudane:", (e as Error).message));
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
  // Debug „bez cache" (x-force-fresh): omiń ODCZYT (świeże generowanie), zapis nadal działa → cache się odświeży.
  if (reqContext.getStore()?.forceFresh) return null;
  // Config (lab): ODCZYT tego rodzaju cache wyłączony → udajemy „miss" (regeneruje), ale cacheSet dalej zapisuje.
  if (!cacheReadEnabled(kind)) return null;
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

export interface CacheSetOpts { ttlDays?: number; lang?: string; model?: string }

/** Zapisuje wartość (L1 + L2, best‑effort). No‑op bez DB poza L1. */
export async function cacheSet(kind: CacheKind, key: string, value: unknown, opts?: CacheSetOpts): Promise<void> {
  if (DISABLED) return;
  // TTL: jawny z wywołania > nadpisanie z configu (LAB) > domyślny rodzaju.
  const ttl = opts?.ttlDays ?? cacheTtlOverride(kind) ?? TTL_DAYS[kind];
  l1Set(key, value, Date.now() + ttl * 86400_000);
  const p = getPool();
  if (!p || !ready) return;
  p.query(
    `INSERT INTO content_cache (key, kind, lang, model, value, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, lang = EXCLUDED.lang, model = EXCLUDED.model,
       created_at = now(), expires_at = EXCLUDED.expires_at, hits = 0, last_hit = NULL`,
    [key, kind, opts?.lang ?? null, opts?.model ?? null, JSON.stringify(value), String(ttl)],
  ).catch((e) => console.error("[cache] set:", (e as Error).message));
}

// --- Single-flight (koalescencja równoległych „miss") -------------------------------------
// Gdy N requestów na ZIMNO prosi o ten sam klucz, bez tego KAŻDY odpala tę samą drogą operację (vision/Serper/
// Places) — N× koszt i N× obciążenie upstreamu w oknie zanim cache się zapisze. Tu: PIERWSZY „leci", reszta
// DOCZEPIA się do jego Promise (coalesced=true) i bierze gotowy wynik. Prymityw NIE dotyka cache — to robi caller
// (cacheGet przed, cacheSet w compute), bo kształt wartości i rozliczenie usage bywają różne (coalesced → usage 0,
// nie płaci drugi raz). Mapa trzyma TYLKO trwające loty (czyszczona w finally). Działa też bez DB (sam L1 + mapa).
const inFlight = new Map<string, Promise<unknown>>();
export function singleFlight<T>(key: string, compute: () => Promise<T>): { promise: Promise<T>; coalesced: boolean } {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return { promise: existing, coalesced: true };
  const run = compute().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return { promise: run, coalesced: false };
}

// --- Batch single-flight (koalescencja per-klucz WEWNĄTRZ wsadowego compute) ----------------
// item-enrich / verify-photos liczą WIELE kluczy JEDNYM wywołaniem modelu (partia) — singleFlight (1 klucz =
// 1 lot) tu nie pasuje. BatchInFlight koordynuje per klucz: `claim` dzieli klucze na OWNED (liczę ja) i BORROWED
// (ktoś już liczy → doczekam jego wynik, bez drugiego compute). Owner po policzeniu woła `resolve(key, val)`;
// klucze, które model POMINĄŁ w partii, domyka `settleRemaining(fallback)`. Bezpieczeństwo: borrowed Promise
// NIGDY nie wisi (timeout → fallback) i NIE rzuca; owned wpis sam się sprząta (timer) gdyby owner padł/zniknął.
export class BatchInFlight<V> {
  private map = new Map<string, { promise: Promise<V>; resolve: (v: V) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly timeoutMs = 30_000) {}
  /** Rejestruje klucze. owned = liczę JA (muszę domknąć resolve/settleRemaining). borrowed = obietnice na CUDZE
   *  loty, zawsze się rozwiążą do V (timeout/fallback wbudowany — bez zawisów, bez rzucania). */
  claim(keys: string[], fallback: (key: string) => V): { owned: string[]; borrowed: Map<string, Promise<V>> } {
    const owned: string[] = [];
    const borrowed = new Map<string, Promise<V>>();
    for (const k of keys) {
      const e = this.map.get(k);
      if (e) { borrowed.set(k, e.promise); continue; }
      let resolve!: (v: V) => void;
      const promise = new Promise<V>((res) => { resolve = res; });
      const timer = setTimeout(() => { if (this.map.get(k)?.promise === promise) { this.map.delete(k); resolve(fallback(k)); } }, this.timeoutMs);
      (timer as { unref?: () => void }).unref?.(); // nie trzymaj procesu przy życiu samym timerem
      this.map.set(k, { promise, resolve, timer });
      owned.push(k);
    }
    return { owned, borrowed };
  }
  /** Domyka MÓJ klucz wynikiem (dla borrowerów) + usuwa z mapy. No-op gdy nie mój / już domknięty. */
  resolve(key: string, value: V): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    clearTimeout(e.timer);
    e.resolve(value);
  }
  /** Domyka pozostałe OWNED klucze (model je pominął / partia padła) fallbackiem — żeby borrower nie czekał do timeoutu. */
  settleRemaining(keys: string[], fallback: (key: string) => V): void {
    for (const k of keys) this.resolve(k, fallback(k)); // resolve = no-op jeśli już domknięte
  }
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

export interface CacheRow { key: string; kind: string; lang: string | null; model: string | null; createdAt: string | null; expiresAt: string | null; hits: number; value: unknown }

/** Przegląd wpisów cache (do podglądu w LABie): filtr po rodzaju + wyszukiwanie w kluczu/wartości.
 *  Źródło: Postgres (pełne metadane) lub — lokalnie bez DB — L1 w pamięci. */
export async function cacheBrowse(opts: { kind?: string; q?: string; limit?: number; allVersions?: boolean }): Promise<{ source: "pg" | "l1"; rows: CacheRow[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 5000);
  // Domyślnie pokazujemy TYLKO bieżącą wersję klucza (`kind:vN:`). Wpisy starych wersji są MARTWE (cacheGet
  // liczy klucz z aktualną CACHE_VERSION, więc nigdy nie trafią) i mają inny układ członów → myliłyby rozbicie
  // w LABie (np. stare 4-członowe vision-url pod 3-członowymi etykietami). allVersions=1 → pokaż wszystkie.
  const verPrefix = !opts.allVersions && opts.kind && opts.kind in CACHE_VERSION
    ? `${opts.kind}:v${CACHE_VERSION[opts.kind as CacheKind]}:` : null;
  const p = getPool();
  if (p && ready) {
    const params: unknown[] = [];
    const where: string[] = ["(expires_at IS NULL OR expires_at > now())"];
    if (opts.kind) { params.push(opts.kind); where.push(`kind = $${params.length}`); }
    if (verPrefix) { params.push(verPrefix + "%"); where.push(`key LIKE $${params.length}`); }
    if (opts.q) { params.push("%" + opts.q.toLowerCase() + "%"); where.push(`(lower(key) LIKE $${params.length} OR lower(value::text) LIKE $${params.length})`); }
    params.push(limit);
    const r = await p.query(
      `SELECT key, kind, lang, model, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
              to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS') AS expires_at, hits, value
       FROM content_cache WHERE ${where.join(" AND ")} ORDER BY hits DESC, created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { source: "pg", rows: r.rows.map((x) => ({ key: x.key, kind: x.kind, lang: x.lang, model: x.model, createdAt: x.created_at, expiresAt: x.expires_at, hits: x.hits, value: x.value })) };
  }
  const q = opts.q?.toLowerCase();
  const rows: CacheRow[] = [];
  for (const [key, e] of L1) {
    const kind = key.split(":")[0] ?? "";
    if (opts.kind && kind !== opts.kind) continue;
    if (verPrefix && !key.startsWith(verPrefix)) continue;
    if (q && !key.toLowerCase().includes(q) && !JSON.stringify(e.value).toLowerCase().includes(q)) continue;
    rows.push({ key, kind, lang: null, model: null, createdAt: null, expiresAt: e.exp ? new Date(e.exp).toISOString().slice(0, 19) : null, hits: 0, value: e.value });
    if (rows.length >= limit) break;
  }
  return { source: "l1", rows };
}

/** Rozmiar cache (bajty wartości + liczba wpisów). Postgres: realny rozmiar tabeli; L1: szacunek. */
export async function cacheSize(): Promise<{ enabled: boolean; bytes: number; rows: number }> {
  const p = getPool();
  if (!p || !ready) {
    let bytes = 0;
    for (const [k, e] of L1) bytes += k.length + JSON.stringify(e.value).length;
    return { enabled: false, bytes, rows: L1.size };
  }
  try {
    const r = await p.query(`SELECT count(*)::int AS n FROM content_cache WHERE expires_at IS NULL OR expires_at > now()`);
    const t = await p.query(`SELECT pg_total_relation_size('content_cache')::bigint AS s`);
    return { enabled: true, bytes: Number(t.rows[0].s), rows: r.rows[0].n };
  } catch {
    return { enabled: false, bytes: 0, rows: 0 };
  }
}

/** Czyści cache (cały lub jednego rodzaju). Do przycisku „wyczyść" w LABie. */
export async function cacheClear(kind?: CacheKind): Promise<void> {
  L1.clear();
  const p = getPool();
  if (!p || !ready) return;
  // Pojedynczy rodzaj: DELETE (filtr po kind). CAŁOŚĆ: TRUNCATE — od razu oddaje miejsce na dysku systemowi
  // (DELETE zostawia martwe krotki/bloat aż do VACUUM FULL), jest też szybszy. Stąd „wyczyść wszystko" realnie
  // kurczy rozmiar tabeli do ~0.
  if (kind) await p.query(`DELETE FROM content_cache WHERE kind = $1`, [kind]).catch(() => {});
  else await p.query(`TRUNCATE content_cache`).catch(() => {});
}
