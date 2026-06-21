// Trwałe logowanie zdarzeń (Postgres) — żeby statystyki przeżywały redeploy/restart.
// Działa BEST‑EFFORT i OPCJONALNIE: bez DATABASE_URL wszystko jest no‑opem, a serwer
// działa normalnie (in‑memory diagnostyka w apiLog.ts zostaje). Zapisy nigdy nie blokują
// ani nie wywalają requestu (błędy łapane i logowane do konsoli).
import { Pool } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

let pool: Pool | null = null;
let ready = false;

// Kontekst per-request: GUID instalacji apki (x-install-id). Dzięki AsyncLocalStorage KAŻDe
// logEvent w obrębie requestu samo dostaje installId — bez przekazywania przez wszystkie wywołania.
export const reqContext = new AsyncLocalStorage<{
  installId?: string; forceFresh?: boolean; sessionId?: string;
  // „app" gdy request pochodzi z PRAWDZIWEJ apki (nagłówek x-client:app). Brak → eksperyment/test (lab,
  // curl Claude itp.). Dzięki temu statystyki domyślnie liczą tylko realne logi z apki.
  source?: string;
  // Akumulator zużycia API per-request (apiLog wpisuje; middleware loguje nie-AI providerów na koniec).
  apiUsage?: Map<string, { calls: number; inTok: number; outTok: number; costUsd: number; bytesSent: number; bytesRecv: number }>;
}>();

/** Współdzielona pula Postgresa (lub null bez DATABASE_URL). Używa też cache.ts. */
export function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      // Railway Postgres bywa za TLS; sslmode w URL zwykle to ogarnia, ale dla pewności:
      ssl: /sslmode=disable/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    });
    pool.on("error", (e) => console.error("[db] pool error:", e.message));
  }
  return pool;
}

/** Tworzy tabelę zdarzeń (idempotentnie). Wołane na starcie serwera. */
export async function initDb(): Promise<void> {
  const p = getPool();
  if (!p) {
    console.log("[db] DATABASE_URL brak — trwałe logi WYŁĄCZONE (działa tylko diagnostyka w pamięci).");
    return;
  }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        type TEXT NOT NULL,
        op TEXT,
        model TEXT,
        provider TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd DOUBLE PRECISION,
        data JSONB,
        install_id TEXT
      );
      ALTER TABLE events ADD COLUMN IF NOT EXISTS install_id TEXT;
      CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at);
      CREATE INDEX IF NOT EXISTS events_type_idx ON events (type);
      CREATE INDEX IF NOT EXISTS events_install_idx ON events (install_id);
      CREATE TABLE IF NOT EXISTS installs (
        install_id TEXT PRIMARY KEY,
        name TEXT,
        device_model TEXT,
        brand TEXT,
        os_name TEXT,
        os_version TEXT,
        app_version TEXT,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    ready = true;
    console.log("[db] trwałe logi GOTOWE (Postgres).");
  } catch (e) {
    console.error("[db] init nieudany — trwałe logi wyłączone:", (e as Error).message);
  }
}

/** Zamyka pulę Postgresa (graceful shutdown). Best‑effort. */
export async function closeDb(): Promise<void> {
  if (pool) {
    try { await pool.end(); } catch { /* ignoruj */ }
    pool = null;
    ready = false;
  }
}

export interface EventInput {
  type: string; // "scan" | "ai" | "error" | ...
  op?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  data?: Record<string, unknown>;
  /** GUID instalacji apki — gdy nie podany, brany z kontekstu requestu (x-install-id). */
  installId?: string;
}

/** Zapisuje zdarzenie (best‑effort, nieblokująco). No‑op bez DB. */
export function logEvent(ev: EventInput): void {
  const p = getPool();
  if (!p || !ready) return;
  const ctx = reqContext.getStore();
  const installId = ev.installId ?? ctx?.installId ?? null;
  // sessionId (sesja usera: od „nowy skan" do „nowy skan") wmergowany w data — bez migracji schematu.
  // To WSPÓLNY element wszystkich ops jednego skanu (peek, scan, enrich, zdjęcia) → grupowanie statystyk.
  const extra: Record<string, unknown> = {};
  if (ctx?.sessionId) extra.sessionId = ctx.sessionId;
  if (ctx?.source) extra.source = ctx.source; // „app" = realna apka; brak → eksperyment/test
  const data = Object.keys(extra).length ? { ...(ev.data ?? {}), ...extra } : ev.data;
  p.query(
    `INSERT INTO events (type, op, model, provider, input_tokens, output_tokens, cost_usd, data, install_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      ev.type,
      ev.op ?? null,
      ev.model ?? null,
      ev.provider ?? null,
      ev.inputTokens ?? null,
      ev.outputTokens ?? null,
      ev.costUsd ?? null,
      data ? JSON.stringify(data) : null,
      installId,
    ],
  ).catch((e) => console.error("[db] logEvent:", (e as Error).message));
}

export interface Stats {
  enabled: boolean;
  since?: string | null;
  totalScans?: number;
  totalDishes?: number;
  totalCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  /** Koszt/tokeny per model po WSZYSTKICH zdarzeniach (skan + opisy + weryfikacja + venue). */
  byModel?: { model: string | null; calls: number; scans: number; cost: number; inputTokens: number; outputTokens: number }[];
  /** Koszt/tokeny per operacja (scan / dish-info / dish-photos / venue-photos). */
  byOp?: { op: string | null; calls: number; cost: number; inputTokens: number; outputTokens: number }[];
  byDay?: { day: string; scans: number }[];
  /** Ostatnie błędy z TRWAŁEGO logu (przeżywają redeploy). */
  recentErrors?: { at: string; provider: string | null; op: string | null; detail: string | null }[];
  errors?: number;
  /** Dzisiejszy koszt $ i dzienny budżet (gdy ustawiony) — do hamulca i podglądu. */
  todayCostUsd?: number;
  dailyBudgetUsd?: number | null;
}

/** Agregaty do ekranu statystyk / eksportu. */
export async function getStats(): Promise<Stats> {
  const p = getPool();
  if (!p || !ready) return { enabled: false };
  const [scans, dishes, totals, byModel, byOp, byDay, errors, recentErrors, since] = await Promise.all([
    p.query(`SELECT count(*)::int AS n FROM events WHERE type='scan'`),
    p.query(`SELECT coalesce(sum((data->>'items')::int),0)::bigint AS n FROM events WHERE type='scan'`),
    p.query(`SELECT coalesce(sum(cost_usd),0) AS cost, coalesce(sum(input_tokens),0)::bigint AS i,
             coalesce(sum(output_tokens),0)::bigint AS o FROM events`),
    // Per MODEL po WSZYSTKICH zdarzeniach (nie tylko skan) — pełny koszt do porównań.
    p.query(`SELECT model, count(*)::int AS calls, count(*) FILTER (WHERE type='scan')::int AS scans,
             coalesce(sum(cost_usd),0) AS cost, coalesce(sum(input_tokens),0)::bigint AS i,
             coalesce(sum(output_tokens),0)::bigint AS o
             FROM events WHERE model IS NOT NULL GROUP BY model ORDER BY cost DESC`),
    // Per OPERACJA (scan / dish-info / dish-photos / venue-photos) — gdzie idą pieniądze.
    // Bez type='error' (błędy mają op, ale brak kosztu → zaśmiecałyby; są w recentErrors).
    p.query(`SELECT op, count(*)::int AS calls, coalesce(sum(cost_usd),0) AS cost,
             coalesce(sum(input_tokens),0)::bigint AS i, coalesce(sum(output_tokens),0)::bigint AS o
             FROM events WHERE op IS NOT NULL AND type <> 'error' GROUP BY op ORDER BY cost DESC`),
    p.query(`SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, count(*)::int AS scans
             FROM events WHERE type='scan' GROUP BY day ORDER BY day DESC LIMIT 30`),
    p.query(`SELECT count(*)::int AS n FROM events WHERE type='error'`),
    // Ostatnie błędy (trwałe) — do sekcji „🔴 Ostatnie błędy".
    p.query(`SELECT to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, provider, op, data->>'detail' AS detail
             FROM events WHERE type='error' ORDER BY id DESC LIMIT 20`),
    p.query(`SELECT to_char(min(created_at),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS s FROM events`),
  ]);
  return {
    enabled: true,
    since: since.rows[0].s,
    totalScans: scans.rows[0].n,
    totalDishes: Number(dishes.rows[0].n),
    totalCostUsd: Number(totals.rows[0].cost),
    totalInputTokens: Number(totals.rows[0].i),
    totalOutputTokens: Number(totals.rows[0].o),
    byModel: byModel.rows.map((r) => ({
      model: r.model,
      calls: r.calls,
      scans: r.scans,
      cost: Number(r.cost),
      inputTokens: Number(r.i),
      outputTokens: Number(r.o),
    })),
    byOp: byOp.rows.map((r) => ({
      op: r.op,
      calls: r.calls,
      cost: Number(r.cost),
      inputTokens: Number(r.i),
      outputTokens: Number(r.o),
    })),
    byDay: byDay.rows,
    errors: errors.rows[0].n,
    recentErrors: recentErrors.rows.map((r) => ({ at: r.at, provider: r.provider, op: r.op, detail: r.detail })),
    todayCostUsd: await getTodayCostUsd(),
    dailyBudgetUsd: dailyBudgetUsd(),
  };
}

// --- Dzienny budżet $ (twardy hamulec na rachunek) ---------------------------------------
let todayCache: { at: number; cost: number } | null = null;

/** Dzisiejszy koszt $ (sum cost_usd od północy UTC). Cache 15 s, by nie pytać DB co wywołanie. */
export async function getTodayCostUsd(): Promise<number> {
  const p = getPool();
  if (!p || !ready) return 0;
  if (todayCache && Date.now() - todayCache.at < 15000) return todayCache.cost;
  try {
    const r = await p.query(
      `SELECT coalesce(sum(cost_usd),0) AS c FROM events WHERE created_at >= date_trunc('day', now())`,
    );
    const cost = Number(r.rows[0].c);
    todayCache = { at: Date.now(), cost };
    return cost;
  } catch {
    return todayCache?.cost ?? 0;
  }
}

/** Budżet dzienny $ z env DAILY_BUDGET_USD (null = brak limitu). */
export function dailyBudgetUsd(): number | null {
  const n = process.env.DAILY_BUDGET_USD ? Number(process.env.DAILY_BUDGET_USD) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Czy przekroczono dzienny budżet (gdy ustawiony). Bez DB / bez budżetu → nigdy. */
export async function budgetExceeded(): Promise<boolean> {
  const budget = dailyBudgetUsd();
  if (budget == null) return false;
  return (await getTodayCostUsd()) >= budget;
}

/** Ostatnie BŁĘDY KLIENTA (zgłoszone z apki) — do zakładki „Błędy" w labie. Z install_id (grupowanie). */
export async function getClientErrors(limit = 300): Promise<{ at: string; op: string | null; installId: string | null; data: Record<string, unknown> | null }[]> {
  const p = getPool();
  if (!p || !ready) return [];
  const r = await p.query(
    `SELECT to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, op, install_id, data
     FROM events WHERE type = 'client-error' ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1000)],
  );
  return r.rows.map((x) => ({ at: x.at, op: x.op, installId: x.install_id, data: x.data }));
}

/** Wszystkie zdarzenia jednej INSTALACJI apki (skany, ai, sample, błędy) — do wglądu „co robiła ta apka". */
export async function getInstallActivity(installId: string, limit = 200): Promise<{ at: string; type: string; op: string | null; model: string | null; costUsd: number | null; data: Record<string, unknown> | null }[]> {
  const p = getPool();
  if (!p || !ready || !installId) return [];
  const r = await p.query(
    `SELECT to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, type, op, model, cost_usd, data
     FROM events WHERE install_id = $1 ORDER BY id DESC LIMIT $2`,
    [installId, Math.min(Math.max(limit, 1), 500)],
  );
  return r.rows.map((x) => ({ at: x.at, type: x.type, op: x.op, model: x.model, costUsd: x.cost_usd != null ? Number(x.cost_usd) : null, data: x.data }));
}

/** Rejestruje/aktualizuje instalację apki (urządzenie + wersja). Wołane na starcie apki. */
export async function upsertInstall(p: { installId: string; deviceModel?: string; brand?: string; osName?: string; osVersion?: string; appVersion?: string }): Promise<void> {
  const pool = getPool();
  if (!pool || !ready || !p.installId) return;
  pool.query(
    `INSERT INTO installs (install_id, device_model, brand, os_name, os_version, app_version)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (install_id) DO UPDATE SET last_seen = now(), app_version = EXCLUDED.app_version,
       device_model = COALESCE(EXCLUDED.device_model, installs.device_model),
       brand = COALESCE(EXCLUDED.brand, installs.brand),
       os_name = COALESCE(EXCLUDED.os_name, installs.os_name),
       os_version = COALESCE(EXCLUDED.os_version, installs.os_version)`,
    [p.installId, p.deviceModel ?? null, p.brand ?? null, p.osName ?? null, p.osVersion ?? null, p.appVersion ?? null],
  ).catch((e) => console.error("[db] upsertInstall:", (e as Error).message));
}

/** Nadaje/zmienia nazwę instalacji (do łatwego rozpoznania). Tworzy wpis, jeśli nie istnieje. */
export async function setInstallName(installId: string, name: string | null): Promise<void> {
  const pool = getPool();
  if (!pool || !ready || !installId) return;
  await pool.query(
    `INSERT INTO installs (install_id, name) VALUES ($1,$2)
     ON CONFLICT (install_id) DO UPDATE SET name = EXCLUDED.name`,
    [installId, name],
  ).catch((e) => console.error("[db] setInstallName:", (e as Error).message));
}

export interface InstallRow {
  installId: string; name: string | null; deviceModel: string | null; brand: string | null; osName: string | null; osVersion: string | null;
  appVersion: string | null; firstSeen: string | null; lastSeen: string | null; lastActivity: string | null;
  scans: number; errors: number; events: number; costUsd: number;
}

/** Lista WSZYSTKICH instalacji (z tabeli installs + te, które tylko logowały zdarzenia) ze statystyką. */
export async function getInstalls(): Promise<InstallRow[]> {
  const pool = getPool();
  if (!pool || !ready) return [];
  const r = await pool.query(`
    WITH ids AS (
      SELECT install_id FROM installs
      UNION SELECT DISTINCT install_id FROM events WHERE install_id IS NOT NULL
    )
    SELECT ids.install_id,
      i.name, i.device_model, i.brand, i.os_name, i.os_version,
      COALESCE(i.app_version, max(e.data->>'appVersion')) AS app_version,
      to_char(COALESCE(i.first_seen, min(e.created_at)),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_seen,
      to_char(GREATEST(i.last_seen, max(e.created_at)),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
      to_char(max(e.created_at),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_activity,
      count(*) FILTER (WHERE e.type='scan')::int AS scans,
      count(*) FILTER (WHERE e.type='client-error')::int AS errors,
      count(e.id)::int AS events,
      coalesce(sum(e.cost_usd),0) AS cost
    FROM ids
    LEFT JOIN installs i ON i.install_id = ids.install_id
    LEFT JOIN events e ON e.install_id = ids.install_id
    GROUP BY ids.install_id, i.name, i.device_model, i.brand, i.os_name, i.os_version, i.app_version, i.first_seen, i.last_seen
    ORDER BY GREATEST(i.last_seen, max(e.created_at)) DESC NULLS LAST LIMIT 500`);
  return r.rows.map((x) => ({
    installId: x.install_id, name: x.name, deviceModel: x.device_model, brand: x.brand, osName: x.os_name, osVersion: x.os_version,
    appVersion: x.app_version, firstSeen: x.first_seen, lastSeen: x.last_seen, lastActivity: x.last_activity,
    scans: x.scans, errors: x.errors, events: x.events, costUsd: Number(x.cost),
  }));
}

/** Ostatnie surowe zdarzenia (do eksportu/debug). */
export async function getRecentEvents(limit = 200): Promise<unknown[]> {
  const p = getPool();
  if (!p || !ready) return [];
  const r = await p.query(
    `SELECT id, created_at, type, op, model, provider, input_tokens, output_tokens, cost_usd, data
     FROM events ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 2000)],
  );
  return r.rows;
}
