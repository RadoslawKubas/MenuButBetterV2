// Tor wyszukiwania zdjęć dla JEDNEJ pozycji menu — WSPÓLNY kod aplikacji i labu.
// Wcześniej cała logika żyła w handlerze /dish-photos (http.ts); wydzielona tutaj, żeby
// LAB mógł odpalić DOKŁADNIE ten sam przebieg (te same tiery, weryfikację, flagę fromVenue)
// na wyeksportowanej migawce i pokazać krok po kroku, co który etap zwrócił.
import {
  genericWebImages,
  restaurantSiteImages,
  venuePortalImages,
  photoSourceCategory,
  OpenverseProvider,
  WikimediaProvider,
  type DishPhoto,
} from "./dishPhotos.ts";
import { scoreDishPhotos, MATCH_THRESHOLD } from "./verifyPhotos.ts";
import { ZERO_USAGE, addUsage, type Usage } from "./usage.ts";

export interface DishPhotosParams {
  dish: string;
  /** Kanoniczna nazwa (EN/native) do szukania OGÓLNEGO zdjęcia (lepsze trafienia niż markowa nazwa). */
  photoQuery?: string;
  /** Nazwa dania w języku KRAJU lokalu — dodatkowy wariant do portali (lokalne trafienia). */
  photoQueryLocal?: string;
  restaurantHint?: string;
  /** Czysta nazwa lokalu — do zawężenia portali i POTWIERDZENIA, że zdjęcie jest z jego strony. */
  restaurantName?: string;
  /** Miasto lokalu — doklejane do zapytań portalowych (odsiewa lokal o podobnej nazwie gdzie indziej). */
  city?: string;
  cuisine?: string;
  /** Strona lokalu (z Google Places) — osobne źródło + kategoria „restaurant". */
  website?: string;
  num?: number;
  /** Weryfikacja vision (DOMYŚLNIE WŁĄCZONA). */
  verify?: boolean;
  /** Model weryfikacji zdjęć (Claude/GPT). Domyślnie Sonnet. */
  verifyModel?: string;
  /** Tylko poglądowe (Wikimedia/Openverse/web) — do tła. */
  representativeOnly?: boolean;
}

export interface OutPhoto {
  url: string;
  source: string;
  attribution?: string;
  verified: boolean;
  representative: boolean;
  fromVenue?: boolean;
}

export interface DbgCandidate {
  url: string;
  domain?: string;
  context?: string;
  score?: number;
  passed?: boolean;
  fromVenue?: boolean;
}
export interface DbgStep {
  tier: string;
  provider: string;
  query: string;
  returned: number;
  passed?: number;
  candidates?: DbgCandidate[];
}
export interface DishPhotosDebug {
  params: Record<string, unknown>;
  steps: DbgStep[];
  resultCount: number;
}

export interface DishPhotosResult {
  photos: OutPhoto[];
  usage: Usage;
  debug: DishPhotosDebug;
}

// Kategorie źródeł, gdzie nazwa lokalu w URL realnie znaczy „strona TEGO lokalu" (ma własny
// profil per lokal). Blog/social/web z nazwą w URL to NIE dowód, że zdjęcie jest z tej restauracji.
const VENUE_PORTAL_CATS = new Set(["tripadvisor", "yelp", "zomato", "thefork", "foursquare"]);

function deaccentLower(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Czy nazwa lokalu występuje w URL-u z GRANICĄ TOKENÓW (nie jako podciąg w środku słowa —
 * „Roma" NIE łapie „aroma"/„romania"). Słowa nazwy mogą być rozdzielone dowolnym separatorem
 * URL (kropka/myślnik/podkreślnik/slash), więc „Indian Taste" pasuje i do „indiantaste.com.pl",
 * i do „…/Indian_Taste-…". Zbyt krótkie/pospolite nazwy (≤4 znaki) odrzucamy — za łatwe fałszywki.
 */
export function venueNameInUrl(contextUrl: string | undefined, name: string): boolean {
  if (!contextUrl || !name) return false;
  const tokens = deaccentLower(name).match(/[a-z0-9]+/g);
  if (!tokens) return false;
  if (tokens.join("").length < 5) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pat = tokens.map(esc).join("[^a-z0-9]*"); // słowa nazwy + dowolny separator między nimi
  const re = new RegExp(`(?:^|[^a-z0-9])${pat}(?:[^a-z0-9]|$)`);
  return re.test(deaccentLower(contextUrl));
}

/**
 * Wyszukuje zdjęcia dla jednej pozycji menu — tier 1 „z lokalu" (strona lokalu + portale),
 * tier 2 szeroko z webu (typ dania), tier 3 poglądowe. Zwraca zdjęcia + zużycie + ślad
 * debug (każdy etap: provider, zapytanie, kandydaci z ocenami vision i flagą fromVenue).
 */
export async function runDishPhotos(p: DishPhotosParams): Promise<DishPhotosResult> {
  const dish = p.dish.trim();
  // Termin do OGÓLNEGO szukania (typ dania) — generyczny `photo_query` z menu, jeśli jest.
  const genericTerm = p.photoQuery?.trim() || dish;
  const verifyModel = p.verifyModel?.trim() || "claude-sonnet-4-6";
  const hint = p.restaurantHint?.trim() || undefined;
  const cuisine = p.cuisine?.trim() || undefined;
  const num = p.num ?? 4;

  // Domena strony lokalu (jeśli znana) — do osobnego wyszukiwania i kategorii „restaurant".
  let restaurantDomain: string | undefined;
  if (p.website?.trim()) {
    try {
      restaurantDomain = new URL(p.website.trim()).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      /* nieprawidłowy URL — pomijamy */
    }
  }
  const venueName = p.restaurantName?.trim() || "";

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const cat = (ph: DishPhoto) => photoSourceCategory(ph.domain, restaurantDomain);
  // POTWIERDZONE „z tego lokalu": (1) własna domena lokalu (mocne) albo (2) nazwa lokalu w URL,
  // ale TYLKO na portalu recenzenckim (tripadvisor/yelp/…) i z granicą tokenów. Wcześniej był to
  // surowy podciąg w dowolnym URL z webu → krótkie/pospolite nazwy łapały obce zdjęcia.
  const fromVenue = (ph: DishPhoto) => {
    const category = cat(ph);
    if (category === "restaurant") return true;
    if (!VENUE_PORTAL_CATS.has(category)) return false;
    return venueNameInUrl(ph.contextUrl, venueName);
  };

  // Próg akceptacji vision per zdjęcie: dla WŁASNEJ strony lokalu łagodniejszy (znamy źródło —
  // wolimy pokazać zdjęcie „z lokalu" nawet przy umiarkowanym dopasowaniu), portale/web normalnie.
  const OWN_SITE_THRESHOLD = 0.45;
  const passThreshold = (ph: DishPhoto) => (cat(ph) === "restaurant" ? OWN_SITE_THRESHOLD : MATCH_THRESHOLD);

  const candListOf = (list: DishPhoto[]): DbgCandidate[] =>
    list.map((ph) => ({ url: ph.url, domain: ph.domain, context: ph.contextUrl, fromVenue: fromVenue(ph) }));
  const candScoredOf = (list: (DishPhoto & { score: number })[]): DbgCandidate[] =>
    list.map((ph) => ({
      url: ph.url,
      domain: ph.domain,
      context: ph.contextUrl,
      score: r2(ph.score),
      passed: ph.score >= passThreshold(ph),
      fromVenue: fromVenue(ph),
    }));

  const dbg: DishPhotosDebug = {
    params: {
      dish,
      photoQuery: p.photoQuery?.trim() || null,
      photoQueryLocal: p.photoQueryLocal?.trim() || null,
      genericTerm,
      restaurantName: p.restaurantName || null,
      city: p.city?.trim() || null,
      restaurantDomain: restaurantDomain || null,
      cuisine: cuisine || null,
      num,
      verify: p.verify !== false,
      representativeOnly: !!p.representativeOnly,
    },
    steps: [],
    resultCount: 0,
  };
  const finish = (photos: OutPhoto[], usage: Usage): DishPhotosResult => {
    dbg.resultCount = photos.length;
    return { photos, usage, debug: dbg };
  };

  // Zdjęcia POGLĄDOWE (typ dania). Kolejność źródeł zależy od REPRESENTATIVE_CC_FIRST:
  //  • domyślnie (tryb testowy): Serper (Google Images, ~93% trafień) → Wikimedia → Openverse,
  //  • CC‑first (produkcja, legalnie bezpieczne): Wikimedia → Openverse (licencje CC/PD) → Serper.
  const CC_FIRST = process.env.REPRESENTATIVE_CC_FIRST === "1";
  async function representatives(verify: boolean): Promise<{ photos: OutPhoto[]; usage: Usage }> {
    const pool = Math.max(num * 2, 6);
    const sources: { name: string; run: () => Promise<DishPhoto[]> }[] = [
      { name: "Serper (web)", run: () => genericWebImages(genericTerm, pool, cuisine) },
      { name: "Wikimedia", run: () => new WikimediaProvider(pool).find(genericTerm) },
      { name: "Openverse", run: () => new OpenverseProvider(pool).find(genericTerm) },
    ];
    const ordered = CC_FIRST ? [sources[1]!, sources[2]!, sources[0]!] : sources;
    let provider = ordered[0]!.name;
    let found: DishPhoto[] = [];
    for (const s of ordered) {
      provider = s.name;
      found = await s.run().catch(() => []);
      if (found.length > 0) break;
    }
    const step: DbgStep = { tier: "Poglądowe (typ dania)", provider, query: genericTerm, returned: found.length };
    dbg.steps.push(step);
    if (found.length === 0) return { photos: [], usage: ZERO_USAGE };
    const srcOf = (ph: DishPhoto) => (ph.domain ? photoSourceCategory(ph.domain) : ph.source);
    if (!verify) {
      step.passed = Math.min(found.length, num);
      step.candidates = candListOf(found);
      return {
        photos: found
          .slice(0, num)
          .map((ph) => ({ url: ph.url, source: srcOf(ph), attribution: ph.attribution, verified: false, representative: true })),
        usage: ZERO_USAGE,
      };
    }
    const { scores, usage } = await scoreDishPhotos(genericTerm, found.map((ph) => ph.url), { cuisine, model: verifyModel });
    const scored = found.map((ph, i) => ({ ...ph, score: scores[i] ?? 0 }));
    step.candidates = candScoredOf(scored);
    const filtered = scored.filter((ph) => ph.score >= MATCH_THRESHOLD).sort((a, b) => b.score - a.score);
    step.passed = filtered.length;
    const photos = filtered
      .slice(0, num)
      .map((ph) => ({ url: ph.url, source: srcOf(ph), attribution: ph.attribution, verified: false, representative: true }));
    return { photos, usage };
  }

  // Tryb poglądowy (do tła po skanie): Wikimedia/Openverse, też weryfikowane (chyba że verify:false).
  if (p.representativeOnly) {
    const { photos, usage } = await representatives(p.verify !== false);
    return finish(photos, usage);
  }

  let total: Usage = ZERO_USAGE;
  const verify = p.verify !== false;

  // Termin do WERYFIKACJI Tier 1 (zdjęcia „z lokalu"): najbardziej OPISOWY — nazwa z menu +
  // photo_query (np. „Mango — mango curry indian"). Sama nazwa pozycji bywa wieloznaczna („Mango"
  // → owoc? lassi? curry?), więc po niej SZUKAMY (tak danie figuruje na stronie/portalu lokalu),
  // ale OCENIAMY po pełnym opisie, który model już wygenerował. Bez tego np. napój mango z portalu
  // przechodził jako „Mango", choć pozycja to mango CURRY.
  // Nazwy do szukania: nazwa z menu (lokalna, jak danie figuruje u lokalu) + kanoniczna (photo_query)
  // + nazwa w języku kraju (photo_query_local). Do WERYFIKACJI używamy terminu opisowego — sama
  // nazwa pozycji bywa wieloznaczna („Mango" → owoc? lassi? curry?).
  const nameMenu = dish;
  const nameCanon = p.photoQuery?.trim() || dish;
  const nameLocal = p.photoQueryLocal?.trim() || "";
  const cityQual = p.city?.trim() || undefined;
  const verifyTerm = nameCanon.toLowerCase() !== nameMenu.toLowerCase() ? `${nameMenu} — ${nameCanon}` : nameMenu;

  // Weryfikuje listę i zwraca te, które pokazują danie (≥ próg), posortowane po trafności.
  async function keepMatching(list: DishPhoto[], term: string = dish) {
    const { scores, usage } = await scoreDishPhotos(term, list.map((ph) => ph.url), { cuisine, model: verifyModel });
    total = addUsage(total, usage);
    const scored = list.map((ph, i) => ({ ...ph, score: scores[i] ?? 0 }));
    const passing = scored.filter((ph) => ph.score >= MATCH_THRESHOLD).sort((a, b) => b.score - a.score);
    return { passing, scored };
  }

  // TIER 1: „z lokalu" — strona lokalu (site:domena, po nazwie z menu) + portale ZAWĘŻONE do
  // lokalu+miasta (po nazwie z menu, kanonicznej i lokalnej), scalone i zweryfikowane wizją.
  const tier1: DishPhoto[] = [];
  if (restaurantDomain) {
    let site = await restaurantSiteImages(nameMenu, restaurantDomain, 6).catch(() => []);
    if (site.length === 0 && nameCanon !== nameMenu) site = await restaurantSiteImages(nameCanon, restaurantDomain, 6).catch(() => []);
    dbg.steps.push({ tier: "Tier1 strona lokalu", provider: `site:${restaurantDomain}`, query: nameMenu, returned: site.length, candidates: candListOf(site) });
    tier1.push(...site);
  }
  {
    const venueQ = [venueName, cityQual].filter(Boolean).join(" ") || hint || "";
    const portal = await venuePortalImages([nameMenu, nameCanon, nameLocal], venueName, cityQual, 6).catch(() => []);
    dbg.steps.push({
      tier: "Tier1 portale (lokal+miasto)",
      provider: "Serper site:portale",
      query: `[${[nameMenu, nameCanon, nameLocal].filter(Boolean).join(" / ")}] ${venueQ}`.trim(),
      returned: portal.length,
      candidates: candListOf(portal),
    });
    tier1.push(...portal);
  }
  const seen = new Set<string>();
  const ctx = tier1.filter((ph) => ph.url && !seen.has(ph.url) && seen.add(ph.url));

  if (!verify && ctx.length > 0) {
    const photos = ctx.slice(0, num).map((ph) => ({
      url: ph.url, source: cat(ph), attribution: ph.attribution, verified: false, representative: false, fromVenue: fromVenue(ph),
    }));
    return finish(photos, ZERO_USAGE);
  }
  if (verify && ctx.length > 0) {
    const { scored } = await keepMatching(ctx, verifyTerm);
    // Próg per-zdjęcie: własna strona lokalu łagodniej (0.45), portale/web normalnie (0.6).
    const passing = scored
      .filter((ph) => ph.score >= passThreshold(ph))
      // Potwierdzone „z tego lokalu" najpierw, potem reszta (w grupie — po trafności).
      .sort((a, b) => (fromVenue(a) ? 0 : 1) - (fromVenue(b) ? 0 : 1) || b.score - a.score);
    dbg.steps.push({ tier: "Tier1 weryfikacja vision", provider: verifyModel, query: verifyTerm, returned: ctx.length, passed: passing.length, candidates: candScoredOf(scored) });
    if (passing.length > 0) {
      const photos = passing.slice(0, num).map((ph) => ({
        url: ph.url, source: cat(ph), attribution: ph.attribution, verified: true, representative: false, fromVenue: fromVenue(ph),
      }));
      return finish(photos, total);
    }
  }

  // TIER 2: SZEROKO z sieci (bez restauracji) — realne zdjęcia tego dania/produktu jako „typ dania".
  if (verify) {
    const generic = await genericWebImages(genericTerm, 6, cuisine);
    if (generic.length > 0) {
      const { passing, scored } = await keepMatching(generic, genericTerm);
      dbg.steps.push({ tier: "Tier2 web (typ dania)", provider: "Serper", query: genericTerm, returned: generic.length, passed: passing.length, candidates: candScoredOf(scored) });
      if (passing.length > 0) {
        const photos = passing.slice(0, num).map((ph) => ({
          url: ph.url, source: cat(ph), attribution: ph.attribution, verified: false, representative: true,
        }));
        return finish(photos, total);
      }
    } else {
      dbg.steps.push({ tier: "Tier2 web (typ dania)", provider: "Serper", query: genericTerm, returned: 0, passed: 0 });
    }
  }

  // TIER 3: poglądowe (Serper→Wikimedia→Openverse) — ostatnia deska.
  const rep = await representatives(verify);
  return finish(rep.photos, addUsage(total, rep.usage));
}
