// NARZĘDZIE REGRESJI PROMPTU (zostaje w repo). Puszcza ekstrakcję struktury (vision) na WSZYSTKICH
// samplach labu i flaguje podejrzane nazwy lokalu (url/domena/agregator/za długie) — do sprawdzania
// po każdej zmianie schematu/promptu w menu.ts/schema.ts. Dedup po sig, równolegle ×4, bez cache.
// Uruchom: npx tsx _exp_robust.ts            (wszystkie, unikalne)
//          npx tsx _exp_robust.ts <id> ...   (wybrane)
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { extractMenu, type InputImage } from "./src/menu.ts";

const LIB = "lab/library";
const caps = JSON.parse(readFileSync(`${LIB}/captures.json`, "utf8")) as any[];

type Job = { id: string; files: string[]; oldName: string | null; sig: string };

function buildJobs(ids?: string[]): Job[] {
  const seen = new Set<string>();
  const jobs: Job[] = [];
  for (const c of caps) {
    if (ids && !ids.includes(c.id)) continue;
    const files = (c.images ?? []).map((i: any) => `${LIB}/${i.file}`).filter((p: string) => existsSync(p));
    if (!files.length) continue;
    const sig = c.sig || c.id;
    if (!ids && seen.has(sig)) continue; // dedup po sig (te same zdjęcia → raz)
    seen.add(sig);
    jobs.push({ id: c.id, files, oldName: (c.result ?? {}).restaurantName ?? null, sig });
  }
  return jobs;
}

// Heurystyka „podejrzana nazwa” do ręcznego przejrzenia (url/domena/agregator/za długie).
const SUSPECT = /(\.(com|pl|net|io|eu)\b|www\.|https?:|pyszne|uber|glovo|wolt|deliveroo|bolt|tripadvisor|facebook|instagram|@)/i;
function flag(name: string | null): string {
  if (!name) return "";
  if (SUSPECT.test(name)) return "  ⚠️ PODEJRZANA";
  if (name.length > 40) return "  ⚠️ DŁUGA";
  return "";
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]!; await fn(x); }
  }));
}

async function main() {
  const argIds = process.argv.slice(2);
  const jobs = buildJobs(argIds.length ? argIds : undefined);
  console.error(`>>> ${jobs.length} unikalnych sampli do sprawdzenia (równolegle 4)\n`);
  let totalCost = 0, done = 0, suspects = 0;
  await pool(jobs, 4, async (j) => {
    try {
      const images: InputImage[] = j.files.map((p) => ({ base64: readFileSync(p).toString("base64"), mediaType: "image/jpeg" as const }));
      const { menu, usage } = await extractMenu(images, { targetLang: "polski", model: "claude-sonnet-4-6", structureOnly: true, noCache: true });
      totalCost += usage.costUsd;
      const f = flag(menu.restaurant_name);
      if (f) suspects++;
      console.error(`[${++done}/${jobs.length}] ${j.id}  old=${JSON.stringify(j.oldName)}  NEW=${JSON.stringify(menu.restaurant_name)}  cuisine=${menu.cuisine}${f}`);
    } catch (e) {
      console.error(`[--] ${j.id}  BŁĄD: ${(e as Error).message}`);
    }
  });
  console.error(`\n>>> KONIEC. sampli=${jobs.length}  podejrzanych=${suspects}  koszt=$${totalCost.toFixed(2)}`);
}
main();
