// Tor wyszukiwania zdjęć dla JEDNEJ pozycji menu — WSPÓLNY kod aplikacji i labu.
// Wcześniej cała logika żyła w handlerze /dish-photos (http.ts); wydzielona tutaj, żeby
// LAB mógł odpalić DOKŁADNIE ten sam przebieg (te same tiery, weryfikację, flagę fromVenue)
// na wyeksportowanej migawce i pokazać krok po kroku, co który etap zwrócił.
import {
  genericWebImages,
  restaurantSiteImages,
  venuePortalImages,
  photoSourceCategory,
  hostOf,
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
  /** location_id wpisu lokalu na TripAdvisor — PEWNY werdykt „z lokalu" dla TA (d<id> w URL). */
  taLocationId?: string;
  /** Markowy/paczkowany produkt (Coca-Cola itp.) → pomijamy szukanie u lokalu, idziemy w generyk. */
  branded?: boolean;
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
  /** Czytelne UZASADNIENIE werdyktu „z lokalu" (czemu tak/nie) — do podglądu w apce i labie. */
  fromVenueReason?: string;
}

export interface DbgCandidate {
  url: string;
  domain?: string;
  context?: string;
  score?: number;
  passed?: boolean;
  fromVenue?: boolean;
  fromVenueReason?: string;
  textOverlay?: boolean;
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

// Kategorie źródeł, gdzie lokal ma WŁASNY profil i nazwa w URL realnie znaczy „strona TEGO lokalu":
// portale recenzenckie + media społecznościowe (Facebook/Instagram — ludzie wrzucają tam realne
// zdjęcia z lokalu). Zwykły blog/web z nazwą w URL to NIE dowód i tu nie wchodzi.
const VENUE_PORTAL_CATS = new Set(["tripadvisor", "yelp", "zomato", "thefork", "foursquare", "social"]);

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
  // UWAGA: Google jako „website" potrafi podać PROFIL SPOŁECZNOŚCIOWY (np. instagram.com/lokal).
  // Wtedy NIE wolno traktować całej domeny (instagram.com) jako strony lokalu — inaczej KAŻDE
  // zdjęcie z instagrama dostaje ★. Rozpoznajemy wtedy konkretny PROFIL (instagram.com/handle).
  const SOCIAL_HOSTS = new Set(["instagram.com", "facebook.com", "fb.com", "twitter.com", "x.com", "tiktok.com", "linktr.ee"]);
  let restaurantDomain: string | undefined;
  let ownSocialUrl: string | undefined; // np. „instagram.com/ferrettibadalona" — profil TEGO lokalu
  if (p.website?.trim()) {
    try {
      const u = new URL(p.website.trim());
      const host = u.hostname.replace(/^(www|m)\./, "").toLowerCase();
      if (SOCIAL_HOSTS.has(host)) {
        const path = u.pathname.replace(/\/+$/, "");
        if (path && path !== "/") ownSocialUrl = (host + path).toLowerCase(); // tylko z konkretnym profilem
      } else {
        restaurantDomain = host;
      }
    } catch {
      /* nieprawidłowy URL — pomijamy */
    }
  }
  const venueName = p.restaurantName?.trim() || "";
  const taLocId = p.taLocationId?.trim() || "";

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const cat = (ph: DishPhoto) => photoSourceCategory(ph.domain, restaurantDomain);
  const domOf = (ph: DishPhoto) => ph.domain || hostOf(ph.contextUrl) || "(brak domeny)";
  // Werdykt „z tego lokalu" + UZASADNIENIE (czytelne, do podglądu). Zasady:
  //  (1) własna domena lokalu (z website) → na pewno z lokalu,
  //  (2) portal recenzencki (tripadvisor/yelp/…) z nazwą lokalu w URL (granica tokenów) → z lokalu,
  //  (3) reszta → NIE (z wyjaśnieniem, czego zabrakło).
  const fromVenueInfo = (ph: DishPhoto): { isVenue: boolean; reason: string } => {
    const category = cat(ph);
    const dom = domOf(ph);
    // Własny PROFIL społecznościowy lokalu (gdy „website" to instagram/facebook/…): pewne, ale tylko
    // gdy URL zdjęcia jest pod tym profilem — nie cały serwis.
    if (ownSocialUrl && ph.contextUrl) {
      const ctxNorm = ph.contextUrl.replace(/^https?:\/\//, "").replace(/^(www|m)\./, "").toLowerCase();
      if (ctxNorm.startsWith(ownSocialUrl + "/") || ctxNorm === ownSocialUrl) {
        return { isVenue: true, reason: `własny profil lokalu (${ownSocialUrl})` };
      }
    }
    if (category === "restaurant") {
      return { isVenue: true, reason: `domena „${dom}" = strona lokalu (${restaurantDomain})` };
    }
    if (!VENUE_PORTAL_CATS.has(category)) {
      const why = restaurantDomain
        ? `domena „${dom}" ≠ strona lokalu (${restaurantDomain}) i nie jest portalem recenzenckim`
        : `domena „${dom}" nie jest portalem recenzenckim, a strony www lokalu nie znamy`;
      return { isVenue: false, reason: `źródło „${category}": ${why}` };
    }
    const urlShown = (ph.contextUrl || "").replace(/^https?:\/\//, "").slice(0, 70);
    // TripAdvisor: PEWNY werdykt po location_id wpisu PRAWDZIWEGO lokalu (d<id> w URL) — odróżnia
    // dwa różne wpisy o tej samej nazwie (inne miasto/oddział), czego sama nazwa nie wyłapie.
    if (category === "tripadvisor" && taLocId) {
      const idRe = new RegExp(`(?:^|[^0-9])d${taLocId}(?:[^0-9]|$)`);
      return idRe.test(ph.contextUrl || "")
        ? { isVenue: true, reason: `TripAdvisor: ten sam wpis lokalu (d${taLocId})` }
        : { isVenue: false, reason: `TripAdvisor: INNY wpis niż nasz lokal (brak d${taLocId} w URL: ${urlShown})` };
    }
    const kind = category === "social" ? "profil społecznościowy" : "portal";
    if (!venueName) {
      return { isVenue: false, reason: `${kind} „${category}", ale nie znamy nazwy lokalu do dopasowania w URL` };
    }
    // Sama nazwa w URL to słaba podstawa, a dla SIECI o jednoczłonowej marce („Ferretti") łapie
    // każdy oddział → wymagamy nazwy WIELOCZŁONOWEJ (np. „Indian Taste"), inaczej nie ufamy.
    const tokens = deaccentLower(venueName).match(/[a-z0-9]+/g) ?? [];
    if (tokens.length < 2) {
      return { isVenue: false, reason: `${kind} „${category}": nazwa „${venueName}" jest jednoczłonowa — zbyt ogólna, by potwierdzić oddział (możliwy inny lokal tej marki)` };
    }
    return venueNameInUrl(ph.contextUrl, venueName)
      ? { isVenue: true, reason: `${kind} „${category}": nazwa „${venueName}" w URL — słabsza podstawa niż ID (${urlShown})` }
      : { isVenue: false, reason: `${kind} „${category}", ale nazwy „${venueName}" NIE ma w URL (${urlShown})` };
  };
  const fromVenue = (ph: DishPhoto) => fromVenueInfo(ph).isVenue;

  // Próg akceptacji vision per zdjęcie: dla WŁASNEJ strony lokalu łagodniejszy (znamy źródło —
  // wolimy pokazać zdjęcie „z lokalu" nawet przy umiarkowanym dopasowaniu), portale/web normalnie.
  const OWN_SITE_THRESHOLD = 0.45;
  const passThreshold = (ph: DishPhoto) => (cat(ph) === "restaurant" ? OWN_SITE_THRESHOLD : MATCH_THRESHOLD);

  const candListOf = (list: DishPhoto[]): DbgCandidate[] =>
    list.map((ph) => {
      const fv = fromVenueInfo(ph);
      return { url: ph.url, domain: ph.domain, context: ph.contextUrl, fromVenue: fv.isVenue, fromVenueReason: fv.reason };
    });
  const candScoredOf = (list: (DishPhoto & { score: number; textOverlay?: boolean })[]): DbgCandidate[] =>
    list.map((ph) => {
      const fv = fromVenueInfo(ph);
      return {
        url: ph.url,
        domain: ph.domain,
        context: ph.contextUrl,
        score: r2(ph.score),
        passed: ph.score >= passThreshold(ph),
        fromVenue: fv.isVenue,
        fromVenueReason: fv.reason,
        textOverlay: ph.textOverlay,
      };
    });
  // Buduje finalne zdjęcie z werdyktem „z lokalu" + powodem (spójnie we wszystkich tierach).
  const outPhoto = (ph: DishPhoto, o: { verified: boolean; representative: boolean; source?: string }): OutPhoto => {
    const fv = fromVenueInfo(ph);
    return {
      url: ph.url,
      source: o.source ?? cat(ph),
      attribution: ph.attribution,
      verified: o.verified,
      representative: o.representative,
      fromVenue: fv.isVenue,
      fromVenueReason: fv.reason,
    };
  };

  const dbg: DishPhotosDebug = {
    params: {
      dish,
      photoQuery: p.photoQuery?.trim() || null,
      photoQueryLocal: p.photoQueryLocal?.trim() || null,
      genericTerm,
      restaurantName: p.restaurantName || null,
      city: p.city?.trim() || null,
      branded: !!p.branded,
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
        photos: found.slice(0, num).map((ph) => outPhoto(ph, { verified: false, representative: true, source: srcOf(ph) })),
        usage: ZERO_USAGE,
      };
    }
    const { scores, textOverlay, usage } = await scoreDishPhotos(genericTerm, found.map((ph) => ph.url), { cuisine, model: verifyModel });
    const scored = found.map((ph, i) => ({ ...ph, score: scores[i] ?? 0, textOverlay: !!textOverlay[i] }));
    step.candidates = candScoredOf(scored);
    const rs = (ph: { score: number; textOverlay?: boolean }) => ph.score - (ph.textOverlay ? 0.15 : 0);
    const filtered = scored.filter((ph) => ph.score >= MATCH_THRESHOLD).sort((a, b) => rs(b) - rs(a));
    step.passed = filtered.length;
    const photos = filtered.slice(0, num).map((ph) => outPhoto(ph, { verified: false, representative: true, source: srcOf(ph) }));
    return { photos, usage };
  }

  // Tryb poglądowy (do tła po skanie): Wikimedia/Openverse, też weryfikowane (chyba że verify:false).
  if (p.representativeOnly) {
    const { photos, usage } = await representatives(p.verify !== false);
    return finish(photos, usage);
  }

  let total: Usage = ZERO_USAGE;
  const verify = p.verify !== false;
  const branded = !!p.branded; // #3: markowy produkt → pomijamy szukanie u lokalu, idziemy w generyk

  // Nazwy do szukania: nazwa z menu (lokalna), kanoniczna (photo_query), w języku kraju
  // (photo_query_local). Do WERYFIKACJI używamy terminu OPISOWEGO — sama nazwa pozycji bywa
  // wieloznaczna („Mango" → owoc? lassi? curry?), więc po niej szukamy, a oceniamy po opisie.
  const nameMenu = dish;
  const nameCanon = p.photoQuery?.trim() || dish;
  const nameLocal = p.photoQueryLocal?.trim() || "";
  const cityQual = p.city?.trim() || undefined;
  const verifyTerm = nameCanon.toLowerCase() !== nameMenu.toLowerCase() ? `${nameMenu} — ${nameCanon}` : nameMenu;

  // #5 DEDUP: globalny klucz. Social (FB/IG): po STRONIE ŹRÓDŁOWEJ (1 zdjęcie / post — łapie ten
  // sam obraz w różnych miniaturach). Bezpośrednie pliki: po nazwie pliku (ten sam obraz z różnych
  // subdomen/stron lokalu). Inaczej po pełnym URL-u (miniatury gstatic mają content-ID w URL).
  const seen = new Set<string>();
  const dedupKey = (ph: DishPhoto): string => {
    if (photoSourceCategory(ph.domain, restaurantDomain) === "social" && ph.contextUrl) {
      return `c:${ph.contextUrl.toLowerCase().split(/[?#]/)[0]}`;
    }
    try {
      const base = (new URL(ph.url).pathname.split("/").pop() || "").toLowerCase();
      if (/\.(jpe?g|png|webp|gif)$/.test(base) && base.replace(/\.[a-z]+$/, "").length >= 8) return `f:${base}`;
    } catch {
      /* nie-URL */
    }
    return `u:${ph.url}`;
  };
  const fresh = (list: DishPhoto[]) => list.filter((ph) => ph.url && !seen.has(dedupKey(ph)) && seen.add(dedupKey(ph)));

  // Akumulator wyniku — zbieramy do `num` przez kolejne źródła (#2), najlepsze (z lokalu) pierwsze.
  const result: OutPhoto[] = [];
  const need = () => num - result.length;
  const pushPhotos = (ps: OutPhoto[]) => { for (const x of ps) if (result.length < num) result.push(x); };

  // Ocena do SORTOWANIA z karą za „wpalony tekst" (#3) — pin/przepis z napisem rankuje niżej niż
  // czyste zdjęcie jedzenia (ale nadal może przejść próg — to tylko kolejność, nie odrzucenie).
  type Scored = DishPhoto & { score: number; textOverlay?: boolean };
  const rankScore = (ph: Scored) => ph.score - (ph.textOverlay ? 0.15 : 0);

  // Weryfikacja listy → oceny + flaga „wpalony tekst" (dolicza koszt).
  async function verifyScored(list: DishPhoto[], term: string): Promise<Scored[]> {
    const { scores, textOverlay, usage } = await scoreDishPhotos(term, list.map((ph) => ph.url), { cuisine, model: verifyModel });
    total = addUsage(total, usage);
    return list.map((ph, i) => ({ ...ph, score: scores[i] ?? 0, textOverlay: !!textOverlay[i] }));
  }

  // Słabo dopasowane zdjęcia z WŁASNEJ strony lokalu (próg 0.45–0.6) — trzymane na koniec: lepsze
  // jest pewne (≥0.6) zdjęcie typu dania niż zły WARIANT z lokalu (np. białe lassi dla „mango lassi").
  let weakVenue: Scored[] = [];

  // ---- A. ZDJĘCIA Z LOKALU (#1) — tylko POTWIERDZONE (własna domena / d<id> TA / nazwa-w-URL). ----
  if (!branded) {
    const venueCands: DishPhoto[] = [];
    if (restaurantDomain) {
      let site = await restaurantSiteImages(nameMenu, restaurantDomain, 6).catch(() => []);
      if (site.length === 0 && nameCanon !== nameMenu) site = await restaurantSiteImages(nameCanon, restaurantDomain, 6).catch(() => []);
      const siteFresh = fresh(site);
      dbg.steps.push({ tier: "Z lokalu — strona www", provider: `site:${restaurantDomain}`, query: nameMenu, returned: site.length, candidates: candListOf(siteFresh) });
      venueCands.push(...siteFresh);
    }
    const portal = await venuePortalImages([nameMenu, nameCanon, nameLocal], venueName, cityQual, 6).catch(() => []);
    const portalFresh = fresh(portal);
    // #1: tylko POTWIERDZONE z lokalu (po URL/domenie/ID — bez vision) trafiają do puli „z lokalu";
    //     reszta z portali/social (cudze zdjęcia dania) jest pomijana — czysty generyk z B jest lepszy.
    const portalVenue = portalFresh.filter((ph) => fromVenue(ph));
    dbg.steps.push({
      tier: "Z lokalu — portale/social",
      provider: "Serper site:portale+social",
      query: `[${[nameMenu, nameCanon, nameLocal].filter(Boolean).join(" / ")}] ${[venueName, cityQual].filter(Boolean).join(" ")}`.trim(),
      returned: portal.length,
      passed: portalVenue.length,
      candidates: candListOf(portalFresh),
    });
    venueCands.push(...portalVenue);

    if (venueCands.length) {
      if (verify) {
        // #4: weryfikujemy NAJPIERW potwierdzone z lokalu (gdy lokal ma dobre pokrycie — tanio, bez B).
        const scored = await verifyScored(venueCands, verifyTerm);
        const passed = scored.filter((ph) => ph.score >= passThreshold(ph));
        // #1: PEWNE z lokalu (≥0.6) idą od razu; SŁABE (0.45–0.6, próg own-site) na koniec.
        const strong = passed
          .filter((ph) => ph.score >= MATCH_THRESHOLD)
          .sort((a, b) => (fromVenue(a) ? 0 : 1) - (fromVenue(b) ? 0 : 1) || rankScore(b) - rankScore(a));
        weakVenue = passed.filter((ph) => ph.score < MATCH_THRESHOLD).sort((a, b) => rankScore(b) - rankScore(a));
        dbg.steps.push({ tier: "Z lokalu — weryfikacja vision", provider: verifyModel, query: verifyTerm, returned: venueCands.length, passed: passed.length, candidates: candScoredOf(scored) });
        pushPhotos(strong.map((ph) => outPhoto(ph, { verified: true, representative: false })));
      } else {
        pushPhotos(venueCands.map((ph) => outPhoto(ph, { verified: false, representative: false })));
      }
    }
  }

  // ---- B. DOPEŁNIENIE POGLĄDOWE (#2) — generyk „typ dania" do `num`. Kolejność wg CC_FIRST. ----
  async function fillRepresentative(): Promise<void> {
    if (need() <= 0) return;
    const pool = Math.max(num * 2, 6);
    const sources: { name: string; run: () => Promise<DishPhoto[]> }[] = [
      { name: "Serper (web)", run: () => genericWebImages(genericTerm, pool, cuisine) },
      { name: "Wikimedia", run: () => new WikimediaProvider(pool).find(genericTerm) },
      { name: "Openverse", run: () => new OpenverseProvider(pool).find(genericTerm) },
    ];
    const ordered = CC_FIRST ? [sources[1]!, sources[2]!, sources[0]!] : sources;
    const srcOf = (ph: DishPhoto) => (ph.domain ? photoSourceCategory(ph.domain) : ph.source);
    for (const s of ordered) {
      if (need() <= 0) break;
      const found = fresh(await s.run().catch(() => []));
      if (!found.length) {
        dbg.steps.push({ tier: "Poglądowe (typ dania)", provider: s.name, query: genericTerm, returned: 0, passed: 0 });
        continue;
      }
      if (!verify) {
        dbg.steps.push({ tier: "Poglądowe (typ dania)", provider: s.name, query: genericTerm, returned: found.length, passed: Math.min(found.length, need()), candidates: candListOf(found) });
        pushPhotos(found.map((ph) => outPhoto(ph, { verified: false, representative: true, source: srcOf(ph) })));
        continue;
      }
      const scored = await verifyScored(found, genericTerm);
      const pass = scored.filter((ph) => ph.score >= MATCH_THRESHOLD).sort((a, b) => rankScore(b) - rankScore(a));
      dbg.steps.push({ tier: "Poglądowe (typ dania)", provider: s.name, query: genericTerm, returned: found.length, passed: pass.length, candidates: candScoredOf(scored) });
      pushPhotos(pass.map((ph) => outPhoto(ph, { verified: false, representative: true, source: srcOf(ph) })));
    }
  }
  await fillRepresentative();

  // #1: na samym końcu — słabe zdjęcia z WŁASNEJ strony lokalu (lepsze niż nic, ale po pewnych i generyku).
  if (need() > 0 && weakVenue.length) {
    pushPhotos(weakVenue.map((ph) => outPhoto(ph, { verified: true, representative: false })));
  }

  return finish(result.slice(0, num), total);
}
