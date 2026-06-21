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
//  Nic z rdzenia od tego nie zależy. (Stałe poprawki — fallback iid/sid w middleware i placePhotoUrl —
//  ZOSTAJĄ, bo używa ich nowa apka.)
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
