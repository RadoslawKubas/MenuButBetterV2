// Trwałe logowanie zdarzeń (Postgres) — żeby statystyki przeżywały redeploy/restart.
// Działa BEST‑EFFORT i OPCJONALNIE: bez DATABASE_URL wszystko jest no‑opem, a serwer
// działa normalnie (in‑memory diagnostyka w apiLog.ts zostaje). Zapisy nigdy nie blokują
// ani nie wywalają requestu (błędy łapane i logowane do konsoli).
import { Pool } from "pg";

let pool: Pool | null = null;
let ready = false;

function getPool(): Pool | null {
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
  byModel?: { model: string | null; scans: number; cost: number }[];
  byDay?: { day: string; scans: number }[];
  errors?: number;
}

/** Agregaty do ekranu statystyk / eksportu. */
export async function getStats(): Promise<Stats> {
  const p = getPool();
  if (!p || !ready) return { enabled: false };
  const [scans, dishes, totals, byModel, byDay, errors, since] = await Promise.all([
    p.query(`SELECT count(*)::int AS n FROM events WHERE type='scan'`),
    p.query(`SELECT coalesce(sum((data->>'items')::int),0)::bigint AS n FROM events WHERE type='scan'`),
    p.query(`SELECT coalesce(sum(cost_usd),0) AS cost, coalesce(sum(input_tokens),0)::bigint AS i,
             coalesce(sum(output_tokens),0)::bigint AS o FROM events`),
    p.query(`SELECT model, count(*)::int AS scans, coalesce(sum(cost_usd),0) AS cost
             FROM events WHERE type='scan' GROUP BY model ORDER BY scans DESC`),
    p.query(`SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, count(*)::int AS scans
             FROM events WHERE type='scan' GROUP BY day ORDER BY day DESC LIMIT 30`),
    p.query(`SELECT count(*)::int AS n FROM events WHERE type='error'`),
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
    byModel: byModel.rows.map((r) => ({ model: r.model, scans: r.scans, cost: Number(r.cost) })),
    byDay: byDay.rows,
    errors: errors.rows[0].n,
  };
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
