// ============================================================================================
//  ⚠️  JEDNORAZOWE NAPRAWY DANYCH — NIE część utrzymywanego rdzenia.  ⚠️
// --------------------------------------------------------------------------------------------
//  To narzędzia do RĘCZNEGO łatania historycznych zdarzeń, które powstały na STARYCH buildach
//  apki (bez nagłówków x-client:app / x-session-id, a zdjęcia lokalu /place-photo bez install_id).
//
//  Gdy NOWA apka stanie się jedynym klientem (wysyła x-client:app + x-session-id na każdym requeście,
//  a placePhotoUrl dokłada &iid=), te funkcje + ich endpointy (/admin/backfill-app-source,
//  /admin/attribute-orphans) + przycisk „📲 oznacz jako z urządzenia" w labie stają się ZBĘDNE.
//
//  WTEDY MOŻNA BEZPIECZNIE USUNĄĆ: ten plik + import w http.ts + oba endpointy + proxy/przycisk w labie.
//  Nic z rdzenia od tego nie zależy. (Stały kanał tożsamości — iid/sid z query w middleware i &iid w
//  placePhotoUrl — ZOSTAJE, bo używa go nowa apka; to NIE naprawa, tylko jak żądania ładowane URL-em
//  identyfikują instancję, tak jak token ?t=.)
// ============================================================================================
import { getReadyPool } from "./db.ts";

/** JEDNORAZOWO: oznacz zdarzenia REALNYCH urządzeń jako data.source="app" — po modelu telefonu i/lub
 *  po install_id (stare buildy nie rejestrowały device_model). Idempotentne. */
export async function backfillAppSource(opts: { deviceModels?: string[]; installIds?: string[] }): Promise<{ updated: number; installs: number }> {
  const p = getReadyPool();
  if (!p) return { updated: 0, installs: 0 };
  const ids = new Set<string>((opts.installIds ?? []).filter(Boolean));
  if (opts.deviceModels?.length) {
    const ir = await p.query(`SELECT install_id FROM installs WHERE device_model = ANY($1)`, [opts.deviceModels]);
    ir.rows.forEach((r) => { if (r.install_id) ids.add(r.install_id); });
  }
  const idArr = [...ids];
  if (!idArr.length) return { updated: 0, installs: 0 };
  const r = await p.query(
    `UPDATE events SET data = COALESCE(data, '{}'::jsonb) || '{"source":"app"}'::jsonb
     WHERE install_id = ANY($1) AND (data->>'source') IS DISTINCT FROM 'app'`,
    [idArr],
  );
  return { updated: r.rowCount ?? 0, installs: idArr.length };
}

/** JEDNORAZOWO: log bez install_id (np. google_places z /place-photo, ładowanego <Image> bez nagłówków)
 *  dostaje install_id + sessionId NAJBLIŻSZEGO w czasie loga, który je MA (w granicy maxGapSec). */
export async function attributeOrphansByTime(maxGapSec = 900): Promise<{ updated: number; remaining: number }> {
  const p = getReadyPool();
  if (!p) return { updated: 0, remaining: 0 };
  const r = await p.query(
    `WITH near AS (
       SELECT o.id,
         (SELECT n.install_id FROM events n
          WHERE n.install_id IS NOT NULL
            AND abs(extract(epoch FROM (n.created_at - o.created_at))) <= $1
          ORDER BY abs(extract(epoch FROM (n.created_at - o.created_at))) LIMIT 1) AS iid,
         (SELECT n.data->>'sessionId' FROM events n
          WHERE n.install_id IS NOT NULL
            AND abs(extract(epoch FROM (n.created_at - o.created_at))) <= $1
          ORDER BY abs(extract(epoch FROM (n.created_at - o.created_at))) LIMIT 1) AS sid
       FROM events o WHERE o.install_id IS NULL
     )
     UPDATE events e
     SET install_id = near.iid,
         data = CASE WHEN near.sid IS NOT NULL
                     THEN COALESCE(e.data, '{}'::jsonb) || jsonb_build_object('sessionId', near.sid)
                     ELSE e.data END
     FROM near WHERE e.id = near.id AND near.iid IS NOT NULL`,
    [maxGapSec],
  );
  const rem = await p.query(`SELECT count(*)::int AS n FROM events WHERE install_id IS NULL`);
  return { updated: r.rowCount ?? 0, remaining: rem.rows[0]?.n ?? 0 };
}

/** JEDNORAZOWO: nadaj SYNTETYCZNY sessionId starym zdarzeniom (bez sessionId) — rekonstrukcja sesji per
 *  instalacja (nowa sesja = SKAN po >3 min od ostatniego skanu, albo przerwa >8 min). Po tym baza może
 *  grupować sesje trywialnie (GROUP BY sessionId) zamiast ładować wszystko i klastrować w JS. */
export async function backfillSyntheticSessions(): Promise<{ updated: number; sessions: number }> {
  const p = getReadyPool();
  if (!p) return { updated: 0, sessions: 0 };
  const r = await p.query<{ id: string; install_id: string | null; op: string | null; ts: string }>(
    `SELECT id, install_id, op, extract(epoch FROM created_at) * 1000 AS ts
     FROM events WHERE (data->>'sessionId') IS NULL ORDER BY install_id NULLS FIRST, created_at`,
  );
  const GAP = 8 * 60_000, COALESCE = 3 * 60_000;
  const ids: string[] = [], sids: string[] = [];
  let curInst: string | null | undefined, cur = "", lastTs = 0, lastScanTs = 0, hasScan = false, n = 0;
  for (const e of r.rows) {
    if (e.install_id !== curInst) { curInst = e.install_id; cur = ""; lastTs = 0; hasScan = false; }
    const ts = Number(e.ts);
    const gap = lastTs && ts - lastTs > GAP;
    const newScan = e.op === "scan" && hasScan && ts - lastScanTs > COALESCE;
    if (!cur || gap || newScan) { cur = "h" + (++n).toString(36) + Math.round(ts / 1000).toString(36); hasScan = false; }
    if (e.op === "scan") { hasScan = true; lastScanTs = ts; }
    ids.push(e.id); sids.push(cur); lastTs = ts;
  }
  if (!ids.length) return { updated: 0, sessions: 0 };
  const upd = await p.query(
    `UPDATE events e SET data = COALESCE(e.data, '{}'::jsonb) || jsonb_build_object('sessionId', v.sid)
     FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS sid) v WHERE e.id = v.id`,
    [ids, sids],
  );
  return { updated: upd.rowCount ?? 0, sessions: n };
}
