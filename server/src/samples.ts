// Magazyn SAMPLI online: apka wysyła migawkę (zip + metadane + hash) na serwer, lab je stamtąd
// pobiera i importuje, a po imporcie zip jest kasowany (zostaje sam hash + „zaimportowany" NA ZAWSZE,
// żeby apka wiedziała). Best‑effort jak db.ts/cache.ts: bez DATABASE_URL wszystko to no‑op (upload
// zwróci „wyłączone", a apka spadnie na zwykły eksport pliku).
import { getPool } from "./db.ts";

let ready = false;

/** Tworzy tabelę sampli (idempotentnie). Wołane na starcie serwera. */
export async function initSamples(): Promise<void> {
  const p = getPool();
  if (!p) {
    console.log("[samples] DATABASE_URL brak — sample online WYŁĄCZONE.");
    return;
  }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS samples (
        id BIGSERIAL PRIMARY KEY,
        hash TEXT UNIQUE NOT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        zip BYTEA,
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        imported_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS samples_imported_idx ON samples (imported_at);
    `);
    ready = true;
    console.log("[samples] sample online GOTOWE (Postgres).");
  } catch (e) {
    console.error("[samples] init nieudany:", (e as Error).message);
    ready = false;
  }
}

export function samplesEnabled(): boolean {
  return ready && !!getPool();
}

export interface SampleRow {
  id: number;
  hash: string;
  meta: Record<string, unknown>;
  bytes: number;
  createdAt: string;
  importedAt: string | null;
  hasZip: boolean;
}

/** Zapisuje sampel (dedup po hashu). Zwraca status: 'created' | 'exists'. */
export async function saveSample(hash: string, meta: Record<string, unknown>, zip: Buffer): Promise<{ ok: boolean; status: "created" | "exists" | "disabled"; id?: number }> {
  const p = getPool();
  if (!p || !ready) return { ok: false, status: "disabled" };
  const existing = await p.query(`SELECT id FROM samples WHERE hash = $1`, [hash]);
  if (existing.rows.length) return { ok: true, status: "exists", id: existing.rows[0].id };
  const r = await p.query(
    `INSERT INTO samples (hash, meta, zip, bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
    [hash, JSON.stringify(meta), zip, zip.length],
  );
  return { ok: true, status: "created", id: r.rows[0].id };
}

/** Lista sampli (bez danych zip). `pending=true` → tylko NIEzaimportowane (do importu w labie). */
export async function listSamples(pending = false): Promise<SampleRow[]> {
  const p = getPool();
  if (!p || !ready) return [];
  const where = pending ? "WHERE imported_at IS NULL AND zip IS NOT NULL" : "";
  const r = await p.query(
    `SELECT id, hash, meta, bytes, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(imported_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS imported_at, (zip IS NOT NULL) AS has_zip
     FROM samples ${where} ORDER BY created_at DESC LIMIT 500`,
  );
  return r.rows.map((x) => ({ id: x.id, hash: x.hash, meta: x.meta, bytes: x.bytes, createdAt: x.created_at, importedAt: x.imported_at, hasZip: x.has_zip }));
}

/** Pobiera zip sampla (Buffer) lub null. */
export async function getSampleZip(id: number): Promise<Buffer | null> {
  const p = getPool();
  if (!p || !ready) return null;
  const r = await p.query(`SELECT zip FROM samples WHERE id = $1`, [id]);
  return r.rows[0]?.zip ?? null;
}

/** Oznacza sampel jako zaimportowany i KASUJE zip (zostaje hash + meta + flaga na zawsze). */
export async function markImported(id: number): Promise<void> {
  const p = getPool();
  if (!p || !ready) return;
  await p.query(`UPDATE samples SET imported_at = now(), zip = NULL WHERE id = $1`, [id]);
}

/** Usuwa sampel całkowicie (cofnięcie wysyłki). */
export async function deleteSample(id: number): Promise<void> {
  const p = getPool();
  if (!p || !ready) return;
  await p.query(`DELETE FROM samples WHERE id = $1`, [id]);
}

/** Status per hash (dla apki): czy jest na serwerze i czy zaimportowany. */
export async function statusByHashes(hashes: string[]): Promise<Record<string, { onServer: boolean; imported: boolean }>> {
  const p = getPool();
  const out: Record<string, { onServer: boolean; imported: boolean }> = {};
  if (!p || !ready || !hashes.length) return out;
  const r = await p.query(`SELECT hash, imported_at IS NOT NULL AS imported FROM samples WHERE hash = ANY($1)`, [hashes]);
  for (const row of r.rows) out[row.hash] = { onServer: true, imported: row.imported };
  return out;
}
