// BENCHMARK weryfikatorów zdjęć dań: zamiast płatnego vision, oceny robią LOKALNE modele (na telefonie: ML Kit
// labeling, CLIP, Apple Vision…). KAŻDY weryfikator ocenia te same zdjęcia, a tu trzymamy WSZYSTKIE werdykty
// per (danie, url, weryfikator) — żeby w LABie porównać i wybrać zwycięzcę. NIC NIE KASUJEMY (to dane do analizy).
// `human` = werdykt usera z LABu (ground-truth). Best-effort jak reszta: bez DATABASE_URL = no-op.
import { getPool } from "./db.ts";

let ready = false;

export interface VerdictItem {
  dish: string;          // tożsamość zdjęcia po stronie wyszukiwania (zwykle photo_query dania) — jak w cache vision-url
  url: string;
  evaluator: string;     // "mlkit-label" | "clip" | "apple-vision" | "human" | ...
  score: number;         // 0..1 (human: 1=dobre, 0=złe)
  label?: string | null; // np. top-etykieta ML Kit / dopasowanie CLIP
  meta?: unknown;        // surowe dane weryfikatora (do analizy)
}
export interface VerdictRow {
  dish: string; url: string; evaluator: string; platform: string | null;
  score: number | null; label: string | null; install_id: string; ts: number;
  meta?: unknown; // surowe query+response weryfikatora (do analizy w LABie)
}

export async function initPhotoVerdicts(): Promise<void> {
  const p = getPool();
  if (!p) {
    console.log("[photo-verdicts] DATABASE_URL brak — benchmark weryfikatorów WYŁĄCZONY.");
    return;
  }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS photo_verdicts (
        dish TEXT NOT NULL,
        url TEXT NOT NULL,
        evaluator TEXT NOT NULL,
        platform TEXT,
        score DOUBLE PRECISION,
        label TEXT,
        meta JSONB,
        install_id TEXT NOT NULL DEFAULT '',
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (dish, url, evaluator, install_id)
      );
      CREATE INDEX IF NOT EXISTS photo_verdicts_ts_idx ON photo_verdicts (ts);
      CREATE INDEX IF NOT EXISTS photo_verdicts_dish_idx ON photo_verdicts (dish);
    `);
    ready = true;
    console.log("[photo-verdicts] benchmark weryfikatorów zdjęć GOTOWE.");
  } catch (e) {
    console.warn("[photo-verdicts] init nieudany:", (e as Error).message);
  }
}

/** Zapisuje BATCH werdyktów (z telefonu/LABu). Upsert per (dish,url,evaluator,install_id) — re-ocena nadpisuje
 *  TEN wpis, ale werdykty innych weryfikatorów/urządzeń zostają. Best-effort. Zwraca liczbę zapisanych. */
export async function saveVerdicts(items: VerdictItem[], installId = "", platform = ""): Promise<number> {
  const p = getPool();
  if (!p || !ready || !items.length) return 0;
  let n = 0;
  for (const it of items) {
    if (!it.dish || !it.url || !it.evaluator) continue;
    const score = Number.isFinite(it.score) ? Math.max(0, Math.min(1, it.score)) : null;
    try {
      await p.query(
        `INSERT INTO photo_verdicts (dish, url, evaluator, platform, score, label, meta, install_id, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (dish, url, evaluator, install_id)
         DO UPDATE SET platform=EXCLUDED.platform, score=EXCLUDED.score, label=EXCLUDED.label, meta=EXCLUDED.meta, ts=now()`,
        [it.dish, it.url, it.evaluator, platform || null, score, it.label ?? null, it.meta != null ? JSON.stringify(it.meta) : null, installId],
      );
      n++;
    } catch { /* pojedynczy wpis się nie zapisał — leć dalej */ }
  }
  return n;
}

/** Ground-truth usera z LABu: oznacz (dish,url) jako dobre/złe (evaluator='human'). */
export async function setHumanVerdict(dish: string, url: string, good: boolean): Promise<void> {
  await saveVerdicts([{ dish, url, evaluator: "human", score: good ? 1 : 0 }], "lab", "lab");
}

/** Z zebranych werdyktów lokalnych modeli: które z `urls` są ZNANE-SŁABE dla tego dania (Apple isUtility=grafika/produkt
 *  LUB bardzo niski CLIP). Agregacja per url (dowolny install). Best-effort — brak DB/danych → pusty Set. Służy do
 *  SPYCHANIA słabych w kolejnych skanach (server-side pamięć). */
export async function weakUrls(dish: string, urls: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const p = getPool();
  if (!p || !ready || !dish || !urls.length) return out;
  try {
    const r = await p.query(
      `SELECT url, evaluator, score, meta FROM photo_verdicts WHERE dish=$1 AND url = ANY($2)`,
      [dish, urls],
    );
    const byUrl = new Map<string, { clip?: number; isUtility?: boolean }>();
    for (const row of r.rows as { url: string; evaluator: string; score: number | null; meta: { raw?: { response?: { isUtility?: boolean } } } | null }[]) {
      const e = byUrl.get(row.url) ?? {};
      if (row.evaluator === "clip" && typeof row.score === "number") e.clip = Math.min(e.clip ?? 1, row.score);
      if (row.evaluator === "apple-vision" && row.meta?.raw?.response?.isUtility) e.isUtility = true;
      byUrl.set(row.url, e);
    }
    for (const [url, e] of byUrl) if (e.isUtility || (typeof e.clip === "number" && e.clip < 0.2)) out.add(url);
  } catch { /* best-effort */ }
  return out;
}

/** Ostatnie werdykty (płaska lista; LAB grupuje po dish,url). Opcjonalnie filtr po daniu. */
export async function listVerdicts(opts: { dish?: string; limit?: number } = {}): Promise<VerdictRow[]> {
  const p = getPool();
  if (!p || !ready) return [];
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 1000));
  try {
    const r = opts.dish
      ? await p.query(`SELECT dish,url,evaluator,platform,score,label,meta,install_id, extract(epoch from ts)*1000 AS ts FROM photo_verdicts WHERE dish=$1 ORDER BY ts DESC LIMIT $2`, [opts.dish, limit])
      : await p.query(`SELECT dish,url,evaluator,platform,score,label,meta,install_id, extract(epoch from ts)*1000 AS ts FROM photo_verdicts ORDER BY ts DESC LIMIT $1`, [limit]);
    return r.rows as VerdictRow[];
  } catch { return []; }
}
