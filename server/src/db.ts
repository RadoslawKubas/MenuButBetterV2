// Trwałe logowanie zdarzeń (Postgres) — żeby statystyki przeżywały redeploy/restart.
// Działa BEST‑EFFORT i OPCJONALNIE: bez DATABASE_URL wszystko jest no‑opem, a serwer
// działa normalnie (in‑memory diagnostyka w apiLog.ts zostaje). Zapisy nigdy nie blokują
// ani nie wywalają requestu (błędy łapane i logowane do konsoli).
import { Pool } from "pg";

let pool: Pool | null = null;
let ready = false;

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
        data JSONB
      );
      CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at);
      CREATE INDEX IF NOT EXISTS events_type_idx ON events (type);
    `);
    ready = true;
    console.log("[db] trwałe logi GOTOWE (Postgres).");
  } catch (e) {
    console.error("[db] init nieudany — trwałe logi wyłączone:", (e as Error).message);
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
}

/** Zapisuje zdarzenie (best‑effort, nieblokująco). No‑op bez DB. */
export function logEvent(ev: EventInput): void {
  const p = getPool();
  if (!p || !ready) return;
  p.query(
    `INSERT INTO events (type, op, model, provider, input_tokens, output_tokens, cost_usd, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ev.type,
      ev.op ?? null,
      ev.model ?? null,
      ev.provider ?? null,
      ev.inputTokens ?? null,
      ev.outputTokens ?? null,
      ev.costUsd ?? null,
      ev.data ? JSON.stringify(ev.data) : null,
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
