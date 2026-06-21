// AGREGACJA SESJI po stronie BAZY (nie ładujemy wszystkich zdarzeń do pamięci). Baza grupuje po sessionId
// i liczy podsumowania; koszt wyceniamy z aktualnego cennika (pricing.ts) na MAŁYM, już pogrupowanym
// wyniku. Zdarzenia jednej sesji czytane osobno (getSessionEvents) — dopiero gdy user kliknie sesję.
import { getReadyPool } from "./db.ts";
import { aiTokenCost, apiCallCost, otherRate, getPriceOverrides } from "./pricing.ts";
import { apiTag } from "./models.ts";

export interface ProviderAgg { provider: string; calls: number; inTok: number; outTok: number; costUsd: number; bytesSent: number }
export interface SessionSummary {
  sessionId: string; installId: string | null; restaurant: string | null;
  start: number; end: number; count: number;
  images: number; dishes: number; photosFetched: number; photoOps: number; cacheHits: number;
  inTok: number; outTok: number; calls: number;
  totalCost: number; tokenCost: number; apiCost: number; dataCost: number;
  byOp: Record<string, { count: number; cost: number }>;
  byProvider: ProviderAgg[];
}

function whereClause(opts: { since?: number; source?: string }, params: unknown[]): string {
  const where: string[] = ["(data->>'sessionId') IS NOT NULL"];
  if (opts.since) { params.push(new Date(opts.since).toISOString()); where.push(`created_at >= $${params.length}`); }
  if (opts.source === "app") where.push(`(data->>'source') = 'app'`);
  else if (opts.source === "exp") where.push(`(data->>'source') IS DISTINCT FROM 'app'`);
  return where.join(" AND ");
}

/** Podsumowania sesji w danym okresie — wszystko policzone w SQL (GROUP BY sessionId) + wycena z cennika. */
export async function getSessions(opts: { since?: number; source?: string }): Promise<SessionSummary[]> {
  const p = getReadyPool();
  if (!p) return [];
  const ov = getPriceOverrides();
  const egress = otherRate("egress", ov);
  const params: unknown[] = [];
  const W = whereClause(opts, params);

  // 1) skalarne pola per sesja
  const sc = await p.query(
    `SELECT data->>'sessionId' AS sid,
       (array_remove(array_agg(install_id ORDER BY created_at), NULL))[1] AS install,
       (array_remove(array_agg(data->>'restaurant'), NULL))[1] AS restaurant,
       extract(epoch FROM min(created_at)) * 1000 AS startms,
       extract(epoch FROM max(created_at)) * 1000 AS endms,
       count(*)::int AS n,
       coalesce(max((data->>'images')::int), 0)::int AS images,
       coalesce(max((data->>'items')::int), 0)::int AS dishes,
       coalesce(sum((data->>'resultCount')::int) FILTER (WHERE op IN ('dish-photos','dish-photo-refresh')), 0)::int AS photos,
       count(*) FILTER (WHERE op IN ('dish-photos','dish-photo-refresh'))::int AS photo_ops,
       count(*) FILTER (WHERE data->>'cached' = 'true')::int AS cache_hits
     FROM events WHERE ${W} GROUP BY data->>'sessionId'`,
    params,
  );
  // 2) drobnoziarniste agregaty do WYCENY (małe — już pogrupowane po sid/op/model/provider)
  const fg = await p.query(
    `SELECT data->>'sessionId' AS sid, op, type, model, provider,
       coalesce(sum(input_tokens), 0)::bigint AS i, coalesce(sum(output_tokens), 0)::bigint AS o,
       count(*)::int AS cnt,
       coalesce(sum((data->>'calls')::int), 0)::int AS calls,
       coalesce(sum((data->>'bytesSent')::bigint), 0)::bigint AS bytes
     FROM events WHERE ${W} GROUP BY data->>'sessionId', op, type, model, provider`,
    params,
  );

  const map = new Map<string, SessionSummary>();
  for (const r of sc.rows as Record<string, any>[]) {
    map.set(r.sid, {
      sessionId: r.sid, installId: r.install ?? null, restaurant: r.restaurant ?? null,
      start: Number(r.startms), end: Number(r.endms), count: r.n,
      images: r.images, dishes: r.dishes, photosFetched: r.photos, photoOps: r.photo_ops, cacheHits: r.cache_hits,
      inTok: 0, outTok: 0, calls: 0, totalCost: 0, tokenCost: 0, apiCost: 0, dataCost: 0, byOp: {}, byProvider: [],
    });
  }
  const provMap = new Map<string, Map<string, ProviderAgg>>();
  for (const r of fg.rows as Record<string, any>[]) {
    const s = map.get(r.sid); if (!s) continue;
    const i = Number(r.i), o = Number(r.o), calls = r.calls, bytes = Number(r.bytes);
    let cost = 0; let provider: string | null = r.provider ?? null;
    if (r.model) { const tc = aiTokenCost(r.model, i, o, ov); cost = tc; s.tokenCost += tc; provider = apiTag(r.model); s.inTok += i; s.outTok += o; }
    else if (r.type === "api" && provider) { const ac = apiCallCost(provider, calls, ov); cost = ac; s.apiCost += ac; s.calls += calls; }
    const dc = (bytes / 1e9) * egress; s.dataCost += dc; cost += dc;
    const op = (r.op as string) || (r.type as string) || "?";
    const bo = (s.byOp[op] = s.byOp[op] || { count: 0, cost: 0 }); bo.count += r.cnt; bo.cost += cost;
    if (provider) {
      let pm = provMap.get(r.sid); if (!pm) { pm = new Map(); provMap.set(r.sid, pm); }
      const pp = pm.get(provider) || { provider, calls: 0, inTok: 0, outTok: 0, costUsd: 0, bytesSent: 0 };
      pp.calls += r.model ? r.cnt : calls; pp.inTok += i; pp.outTok += o; pp.costUsd += cost; pp.bytesSent += bytes;
      pm.set(provider, pp);
    }
    s.totalCost += cost;
  }
  for (const [sid, pm] of provMap) { const s = map.get(sid); if (s) s.byProvider = [...pm.values()].sort((a, b) => b.costUsd - a.costUsd); }
  return [...map.values()].sort((a, b) => b.end - a.end);
}

/** Liczba operacji app vs eksperyment w okresie (do nagłówka statystyk) — czysty count w SQL. */
export async function getSourceCounts(since?: number): Promise<{ appCount: number; expCount: number }> {
  const p = getReadyPool();
  if (!p) return { appCount: 0, expCount: 0 };
  const params: unknown[] = [];
  let w = "(data->>'sessionId') IS NOT NULL";
  if (since) { params.push(new Date(since).toISOString()); w += ` AND created_at >= $${params.length}`; }
  const r = await p.query(
    `SELECT count(*) FILTER (WHERE (data->>'source') = 'app')::int AS app,
            count(*) FILTER (WHERE (data->>'source') IS DISTINCT FROM 'app')::int AS exp
     FROM events WHERE ${w}`,
    params,
  );
  return { appCount: r.rows[0]?.app ?? 0, expCount: r.rows[0]?.exp ?? 0 };
}

/** Zdarzenia JEDNEJ sesji (flow) — czytane dopiero na klik. */
export async function getSessionEvents(sessionId: string, limit = 2000): Promise<unknown[]> {
  const p = getReadyPool();
  if (!p) return [];
  const r = await p.query(
    `SELECT id, created_at, type, op, model, provider, input_tokens, output_tokens, cost_usd, data, install_id
     FROM events WHERE data->>'sessionId' = $1 ORDER BY created_at LIMIT $2`,
    [sessionId, Math.min(Math.max(limit, 1), 5000)],
  );
  return r.rows;
}
