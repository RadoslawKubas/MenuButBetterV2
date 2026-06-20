// Magazyn SAMPLI online: apka wysyła migawkę (zip + metadane + hash) na serwer, lab je stamtąd
// pobiera i importuje, a po imporcie zip jest kasowany (zostaje sam hash + „zaimportowany" NA ZAWSZE,
// żeby apka wiedziała). Best‑effort jak db.ts/cache.ts: bez DATABASE_URL wszystko to no‑op.
//
// MAGAZYN ZIPÓW — HYBRYDA (sam się dobiera, bez Twojej konfiguracji):
//  • jeśli jest trwały katalog (env SAMPLES_DIR albo Railway Volume zamontowany w /data) →
//    zipy lecą jako PLIKI, a w bazie tylko ścieżka + metadane (czysto, baza nieobciążona),
//  • jeśli takiego katalogu nie ma → fallback: zip trzymany w bazie (BYTEA), jak dotąd.
// Dzięki temu działa OD RAZU; gdy podepniesz Volume (jeden klik, mount /data) — automatycznie
// przełącza się na pliki, bez zmian w kodzie/apce.
import { existsSync, mkdirSync } from "node:fs";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getPool } from "./db.ts";

/** Bezpieczna nazwa pliku z (target,hash) — hash ma slashe/znaki specjalne, a (hash,target) to tożsamość. */
function safeFileName(hash: string, target = "lab"): string {
  return createHash("sha256").update(target + "|" + hash).digest("hex") + ".zip";
}

let ready = false;
let storeDir: string | null = null; // katalog plików zipów (null = tryb BYTEA w bazie)

/** Ustala trwały katalog na zipy: SAMPLES_DIR, albo /data (Railway Volume). null = brak → bytea. */
function resolveStoreDir(): string | null {
  const candidates = process.env.SAMPLES_DIR ? [process.env.SAMPLES_DIR] : existsSync("/data") ? ["/data/samples"] : [];
  for (const d of candidates) {
    try {
      mkdirSync(d, { recursive: true });
      return d;
    } catch {
      /* niezapisywalny — próbuj dalej */
    }
  }
  return null;
}

/** Tworzy tabelę sampli (idempotentnie) + ustala magazyn zipów. Wołane na starcie serwera. */
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
        hash TEXT NOT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        zip BYTEA,
        path TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        install_id TEXT,
        content_hash TEXT,
        target TEXT NOT NULL DEFAULT 'lab',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        imported_at TIMESTAMPTZ
      );
      ALTER TABLE samples ADD COLUMN IF NOT EXISTS path TEXT;
      ALTER TABLE samples ADD COLUMN IF NOT EXISTS install_id TEXT;
      ALTER TABLE samples ADD COLUMN IF NOT EXISTS content_hash TEXT;
      ALTER TABLE samples ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'lab';
      -- Tożsamość po (hash, target): ten sam sig może iść osobno do labu i do apki.
      ALTER TABLE samples DROP CONSTRAINT IF EXISTS samples_hash_key;
      CREATE UNIQUE INDEX IF NOT EXISTS samples_hash_target_idx ON samples (hash, target);
      CREATE INDEX IF NOT EXISTS samples_imported_idx ON samples (imported_at);
    `);
    storeDir = resolveStoreDir();
    ready = true;
    console.log(`[samples] sample online GOTOWE (zipy: ${storeDir ? "pliki w " + storeDir : "BYTEA w bazie — podepnij Volume /data, by przejść na pliki"}).`);
  } catch (e) {
    console.error("[samples] init nieudany:", (e as Error).message);
    ready = false;
  }
}

export function samplesEnabled(): boolean {
  return ready && !!getPool();
}

/** Tryb magazynu zipów do diagnostyki: "files" (Volume/katalog) / "db" (BYTEA) / "off". */
export function storeMode(): { mode: "files" | "db" | "off"; dir: string | null } {
  if (!samplesEnabled()) return { mode: "off", dir: null };
  return storeDir ? { mode: "files", dir: storeDir } : { mode: "db", dir: null };
}

export interface SampleRow {
  id: number;
  hash: string;
  meta: Record<string, unknown>;
  bytes: number;
  installId: string | null;
  createdAt: string;
  importedAt: string | null;
  hasZip: boolean;
}

/**
 * Zapisuje sampel. Tożsamość po `hash` (sygnatura WEJŚCIA = zdjęcia). Gdy sampel o tym hashu już jest:
 *  • identyczna TREŚĆ (ten sam content_hash zipa) → "exists" (no-op),
 *  • inna treść (np. apka zapisała NOWY wynik po re-skanie) → AKTUALIZUJ zip+meta i ustaw pending
 *    (imported_at=NULL), żeby lab re-importował i podmienił wynik → "updated".
 * Zip → plik (gdy mamy katalog) albo BYTEA. Tag instancji apki.
 */
export async function saveSample(hash: string, meta: Record<string, unknown>, zip: Buffer, installId?: string, target = "lab"): Promise<{ ok: boolean; status: "created" | "updated" | "exists" | "disabled"; id?: number }> {
  const p = getPool();
  if (!p || !ready) return { ok: false, status: "disabled" };
  const contentHash = createHash("sha256").update(zip).digest("hex");
  const existing = await p.query(`SELECT id, content_hash FROM samples WHERE hash = $1 AND target = $2`, [hash, target]);
  if (existing.rows.length) {
    const row = existing.rows[0];
    if (row.content_hash === contentHash) return { ok: true, status: "exists", id: row.id };
    // Zmodyfikowany sampel (nowa treść) → nadpisz i oznacz jako świeży do (ponownego) importu.
    if (storeDir) {
      const fname = safeFileName(hash, target);
      await writeFile(join(storeDir, fname), zip);
      await p.query(`UPDATE samples SET meta=$2, path=$3, zip=NULL, bytes=$4, install_id=COALESCE($5,install_id), content_hash=$6, imported_at=NULL WHERE id=$1`, [row.id, JSON.stringify(meta), fname, zip.length, installId ?? null, contentHash]);
    } else {
      await p.query(`UPDATE samples SET meta=$2, zip=$3, path=NULL, bytes=$4, install_id=COALESCE($5,install_id), content_hash=$6, imported_at=NULL WHERE id=$1`, [row.id, JSON.stringify(meta), zip, zip.length, installId ?? null, contentHash]);
    }
    return { ok: true, status: "updated", id: row.id };
  }

  if (storeDir) {
    const fname = safeFileName(hash, target);
    await writeFile(join(storeDir, fname), zip);
    const r = await p.query(`INSERT INTO samples (hash, meta, path, bytes, install_id, content_hash, target) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [hash, JSON.stringify(meta), fname, zip.length, installId ?? null, contentHash, target]);
    return { ok: true, status: "created", id: r.rows[0].id };
  }
  const r = await p.query(`INSERT INTO samples (hash, meta, zip, bytes, install_id, content_hash, target) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [hash, JSON.stringify(meta), zip, zip.length, installId ?? null, contentHash, target]);
  return { ok: true, status: "created", id: r.rows[0].id };
}

/** Lista sampli (bez danych zip) dla kierunku `target` ('lab'=apka→lab, 'app'=lab→apka). `pending`
 *  → tylko NIEzaimportowane (z zipem do pobrania). */
export async function listSamples(pending = false, target = "lab"): Promise<SampleRow[]> {
  const p = getPool();
  if (!p || !ready) return [];
  const cond = ["target = $1"];
  if (pending) cond.push("imported_at IS NULL AND (zip IS NOT NULL OR path IS NOT NULL)");
  const r = await p.query(
    `SELECT id, hash, meta, bytes, install_id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(imported_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS imported_at,
            (zip IS NOT NULL OR path IS NOT NULL) AS has_zip
     FROM samples WHERE ${cond.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
    [target],
  );
  return r.rows.map((x) => ({ id: x.id, hash: x.hash, meta: x.meta, bytes: x.bytes, installId: x.install_id, createdAt: x.created_at, importedAt: x.imported_at, hasZip: x.has_zip }));
}

/** Pobiera zip sampla (Buffer) — z pliku albo z BYTEA — lub null. */
export async function getSampleZip(id: number): Promise<Buffer | null> {
  const p = getPool();
  if (!p || !ready) return null;
  const r = await p.query(`SELECT zip, path FROM samples WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.path && storeDir) {
    try { return await readFile(join(storeDir, row.path)); } catch { return null; }
  }
  return row.zip ?? null;
}

/** Oznacza sampel jako zaimportowany i KASUJE zip (plik + bytea); hash+meta+flaga zostają na zawsze. */
export async function markImported(id: number): Promise<void> {
  const p = getPool();
  if (!p || !ready) return;
  const r = await p.query(`SELECT path FROM samples WHERE id = $1`, [id]);
  const path = r.rows[0]?.path as string | undefined;
  if (path && storeDir) await unlink(join(storeDir, path)).catch(() => {});
  await p.query(`UPDATE samples SET imported_at = now(), zip = NULL, path = NULL WHERE id = $1`, [id]);
}

/** Usuwa sampel całkowicie (cofnięcie wysyłki) — wraz z plikiem zip, jeśli jest. */
export async function deleteSample(id: number): Promise<void> {
  const p = getPool();
  if (!p || !ready) return;
  const r = await p.query(`SELECT path FROM samples WHERE id = $1`, [id]);
  const path = r.rows[0]?.path as string | undefined;
  if (path && storeDir) await unlink(join(storeDir, path)).catch(() => {});
  await p.query(`DELETE FROM samples WHERE id = $1`, [id]);
}

/** Status per hash (dla apki): czy jest na serwerze i czy zaimportowany. */
export async function statusByHashes(hashes: string[]): Promise<Record<string, { onServer: boolean; imported: boolean }>> {
  const p = getPool();
  const out: Record<string, { onServer: boolean; imported: boolean }> = {};
  if (!p || !ready || !hashes.length) return out;
  // Status dotyczy uploadów apki (kierunek 'lab'); kolejka 'app' to osobna sprawa.
  const r = await p.query(`SELECT hash, imported_at IS NOT NULL AS imported FROM samples WHERE target = 'lab' AND hash = ANY($1)`, [hashes]);
  for (const row of r.rows) out[row.hash] = { onServer: true, imported: row.imported };
  return out;
}
