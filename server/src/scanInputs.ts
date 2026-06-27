// Zdjęcia WEJŚCIOWE skanu (te FAKTYCZNIE wysłane do analizy) — przechowywane TYMCZASOWO (24h) per sesja usera
// (klucz = x-session-id, ten sam, po którym grupują się Statystyki). Cel: w LABie zobaczyć „co poszło do modelu",
// bez trzymania tego na zawsze. Po 24h auto-kasowane (pruning). BYTEA w bazie — rozmiar ograniczony retencją.
// Best-effort jak db.ts/samples.ts: bez DATABASE_URL = no-op (skan działa normalnie, po prostu bez podglądu).
import { getPool } from "./db.ts";

const TTL_HOURS = 24;
let ready = false;

/** Tworzy tabelę (idempotentnie) + odpala pruning. Wołane na starcie serwera. */
export async function initScanInputs(): Promise<void> {
  const p = getPool();
  if (!p) {
    console.log("[scan-inputs] DATABASE_URL brak — podgląd zdjęć skanu WYŁĄCZONY.");
    return;
  }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS scan_inputs (
        session_id TEXT NOT NULL,
        idx INT NOT NULL,
        media_type TEXT,
        img BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, idx)
      );
      CREATE INDEX IF NOT EXISTS scan_inputs_created_idx ON scan_inputs (created_at);
    `);
    // Analiza on-device WYSŁANA RAZEM z wycinkiem (apka liczy co może; serwer na razie tylko GROMADZI — decyzja/triaż
    // po stronie serwera = później). Kolumny dokładane idempotentnie (stare wdrożenia bez nich → ADD COLUMN IF NOT EXISTS).
    await p.query(`
      ALTER TABLE scan_inputs ADD COLUMN IF NOT EXISTS ocr JSONB;
      ALTER TABLE scan_inputs ADD COLUMN IF NOT EXISTS menu_ai JSONB;
      ALTER TABLE scan_inputs ADD COLUMN IF NOT EXISTS menu_ai_crop JSONB;
      ALTER TABLE scan_inputs ADD COLUMN IF NOT EXISTS src_hash TEXT;
    `);
    ready = true;
    await pruneScanInputs();
    setInterval(() => { void pruneScanInputs(); }, 3600_000).unref?.(); // sprzątaj co godzinę
    console.log(`[scan-inputs] podgląd zdjęć skanu GOTOWE (retencja ${TTL_HOURS}h).`);
  } catch (e) {
    console.warn("[scan-inputs] init nieudany:", (e as Error).message);
  }
}

/** Kasuje wpisy starsze niż TTL — wołane na starcie i cyklicznie. */
export async function pruneScanInputs(): Promise<void> {
  const p = getPool();
  if (!p || !ready) return;
  try { await p.query(`DELETE FROM scan_inputs WHERE created_at < now() - interval '${TTL_HOURS} hours'`); } catch { /* best-effort */ }
}

/** Analiza on-device dołączona do wycinka (apka liczy, serwer GROMADZI; użycie/triaż = później). */
export interface ScanInputAnalysis { ocr?: unknown; menuAi?: unknown; menuAiCrop?: unknown; srcHash?: string }

/** Zapisuje JEDNO zdjęcie wejściowe skanu (base64 → BYTEA) pod (sessionId, idx) + opcjonalnie analizę on-device
 *  (OCR/menu-AI/menu-AI-crop) RAZEM z wycinkiem. Upsert (re-scan nadpisuje). */
export async function saveScanInput(sessionId: string, idx: number, base64: string, mediaType: string, analysis?: ScanInputAnalysis): Promise<void> {
  const p = getPool();
  if (!p || !ready || !sessionId) return;
  try {
    const buf = Buffer.from(base64, "base64");
    if (!buf.length) return;
    const ocr = analysis?.ocr != null ? JSON.stringify(analysis.ocr) : null;
    const menuAi = analysis?.menuAi != null ? JSON.stringify(analysis.menuAi) : null;
    const menuAiCrop = analysis?.menuAiCrop != null ? JSON.stringify(analysis.menuAiCrop) : null;
    const srcHash = analysis?.srcHash ?? null;
    await p.query(
      `INSERT INTO scan_inputs (session_id, idx, media_type, img, ocr, menu_ai, menu_ai_crop, src_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (session_id, idx) DO UPDATE SET media_type = EXCLUDED.media_type, img = EXCLUDED.img,
         ocr = COALESCE(EXCLUDED.ocr, scan_inputs.ocr), menu_ai = COALESCE(EXCLUDED.menu_ai, scan_inputs.menu_ai),
         menu_ai_crop = COALESCE(EXCLUDED.menu_ai_crop, scan_inputs.menu_ai_crop),
         src_hash = COALESCE(EXCLUDED.src_hash, scan_inputs.src_hash), created_at = now()`,
      [sessionId, idx, mediaType, buf, ocr, menuAi, menuAiCrop, srcHash],
    );
  } catch { /* best-effort — NIE blokuje skanu */ }
}

/** Indeksy dostępnych (≤24h) zdjęć danej sesji — do listy miniatur w LABie. */
export async function scanInputIndices(sessionId: string): Promise<{ idx: number; mediaType: string | null }[]> {
  const p = getPool();
  if (!p || !ready) return [];
  try {
    const r = await p.query(
      `SELECT idx, media_type FROM scan_inputs WHERE session_id = $1 AND created_at > now() - interval '${TTL_HOURS} hours' ORDER BY idx`,
      [sessionId],
    );
    return r.rows.map((row) => ({ idx: Number(row.idx), mediaType: (row.media_type as string) ?? null }));
  } catch { return []; }
}

/** Pojedyncze zdjęcie (≤24h) do podglądu. null = brak / wygasło. */
export async function getScanInput(sessionId: string, idx: number): Promise<{ img: Buffer; mediaType: string } | null> {
  const p = getPool();
  if (!p || !ready) return null;
  try {
    const r = await p.query(
      `SELECT img, media_type FROM scan_inputs WHERE session_id = $1 AND idx = $2 AND created_at > now() - interval '${TTL_HOURS} hours'`,
      [sessionId, idx],
    );
    if (!r.rows.length) return null;
    return { img: r.rows[0].img as Buffer, mediaType: (r.rows[0].media_type as string) || "image/jpeg" };
  } catch { return null; }
}
