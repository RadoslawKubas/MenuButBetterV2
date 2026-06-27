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
import { stepEnabled, type ToggleStep } from "./runtimeConfig.ts";
import { ZERO_USAGE, addUsage, type Usage } from "./usage.ts";
import { cacheGet, cacheSet, cacheKey, singleFlight } from "./cache.ts";
import { weakUrls } from "./photoVerdicts.ts";

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
  /** Pomiń cache (LAB / porównania modeli — by liczyć realny koszt). */
  noCache?: boolean;
  /** „Bierz wszystko": zwróć też zdjęcia ODRZUCONE (poniżej progu), oznaczone, posortowane — do wglądu.
   *  W labie/teście włączone i tak (żeby było widać, co realnie wpada). Domyślnie w apce wyłączone. */
  takeAll?: boolean;
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
  /** URL STRONY źródłowej zdjęcia (gdzie znaleziono obraz) — do klikalnego „źródło" w podglądzie apki. */
  contextUrl?: string;
  /** Domena źródła (host) — do pokazania nazwy strony przy zdjęciu. */
  domain?: string;
  /** Zdjęcie poglądowe podane Z CACHE (nie wymagało płatnego wyszukania/weryfikacji). */
  cached?: boolean;
  /** Ocena vision 0..1 (jak bardzo zdjęcie pasuje do dania). Zapamiętana, by pokazać na podglądzie. */
  score?: number;
  /** Odrzucone (poniżej progu jakości) — zwracane tylko przy „bierz wszystko"/teście, oznaczone. */
  rejected?: boolean;
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
  /** Czy poglądowe poszły Z CACHE (zero płatnego wyszukania/weryfikacji). */
  fromCache?: boolean;
  /** SUROWE wyniki per wyszukiwarka — DOKŁADNE pytanie wysłane do API + URL-e zwrócone PRZED weryfikacją.
   *  `prov` = kanoniczny id providera (serper/wikimedia/openverse) — do połączenia ze zdarzeniem kosztu. */
  searched?: { provider: string; prov?: string; query?: string; urls: string[] }[];
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
 * Klucz cache zdjęć POGLĄDOWYCH (typ dania) — wspólny dla pipeline’u i endpointu samonaprawy,
 * żeby refresh trafiał DOKŁADNIE w ten sam wpis. Zależy od: termin generyczny (photo_query lub
 * nazwa) + kuchnia + model weryfikacji + tryb źródeł (CC/web) + liczba zdjęć.
 */
/** Kanoniczny klucz z nazwy: bez akcentów, małe litery, znaki niealfanumeryczne → pojedyncza spacja.
 *  ZACHOWUJE KOLEJNOŚĆ I TOŻSAMOŚĆ SŁÓW (bez sortu/dedupu) — bo kolejność niesie znaczenie dania
 *  („arroz con pollo" ≠ „pollo con arroz"). Spójność z `full_name` ze skanu daje stabilny, wspólny termin. */
function canonKey(s: string): string {
  return deaccentLower(s).replace(/[^a-z0-9]+/g, " ").trim();
}

/** Skraca termin do RDZENIA (pierwsze N słów) — dla Wikimedia/Openverse, które szukają po TYTULE/TEKŚCIE:
 *  pełny opisowy photo_query trafia w długie dokumenty (skany książek kucharskich), a 1–3 słowa kluczowe
 *  trafiają w realne zdjęcia. Serper (Google Images) zostaje z pełnym opisem (inny silnik). */
function shortTerm(term: string, maxWords = 3): string {
  const w = term.trim().split(/\s+/).filter(Boolean);
  return w.slice(0, maxWords).join(" ") || term.trim();
}

export function reprPhotoCacheKey(args: { dish: string; photoQuery?: string; cuisine?: string; verifyModel?: string; num?: number; verify?: boolean; takeAll?: boolean }): string {
  // KLUCZ po KANONICZNEJ nazwie (photo_query — angielski, „opisz CZYM danie jest" + kuchnia), znormalizowanej
  // tak, by była POWTARZALNA mimo niedeterminizmu LLM i wspólna cross-język. Brak photo_query → fallback do
  // samej nazwy dania. Człony klucza: termin + TRYB weryfikacji („verify"/„noverify"). ŚWIADOMIE NIE w kluczu:
  // MODEL weryfikacji (osobna metadana), kuchnia (redundantna — photo_query już niesie kontekst kuchni; nadal
  // używana w wyszukiwaniu/weryfikacji), „cc/web" (env REPRESENTATIVE_CC_FIRST nieustawiany; tylko tie-break),
  // „all/top" (takeAll — apka nie wysyła; do cache i tak zapisujemy TYLKO dobre) oraz LICZBA `num` (knob
  // GŁĘBOKOŚCI szukania, nie tożsamość; apka zawsze 3, a wynik to WSZYSTKIE które przeszły próg).
  const pq = args.photoQuery?.trim();
  const term = pq ? canonKey(pq) : deaccentLower(args.dish.trim());
  const verifyFlag = args.verify !== false;
  // TRYB weryfikacji (on/off) zostaje — zmienia ZBIÓR wyników (off = każde 0.9). MODEL weryfikacji NIE w
  // kluczu (osobna metadana) — różne modele weryfikacji dzielą wpis.
  return cacheKey("repr-photos", term, verifyFlag ? "verify" : "noverify");
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
  const outPhoto = (ph: DishPhoto, o: { verified: boolean; representative: boolean; source?: string; score?: number; rejected?: boolean }): OutPhoto => {
    const fv = fromVenueInfo(ph);
    return {
      url: ph.url,
      source: o.source ?? cat(ph),
      attribution: ph.attribution,
      verified: o.verified,
      representative: o.representative,
      fromVenue: fv.isVenue,
      fromVenueReason: fv.reason,
      contextUrl: ph.contextUrl,
      domain: ph.domain ?? hostOf(ph.contextUrl) ?? undefined,
      score: o.score,
      rejected: o.rejected,
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
    searched: [],
    resultCount: 0,
  };
  const finish = async (photos: OutPhoto[], usage: Usage): Promise<DishPhotosResult> => {
    // SERVER-SIDE PAMIĘĆ SŁABYCH: spychamy na KONIEC zdjęcia znane-słabe z lokalnych werdyktów (Apple isUtility/niski
    // CLIP). ★ z lokalu (fromVenue) NIGDY nie ruszamy. Best-effort — brak DB/danych → kolejność bez zmian.
    try {
      const rest = photos.filter((ph) => !ph.fromVenue && ph.url);
      if (rest.length > 1) {
        const weak = await weakUrls(p.photoQuery?.trim() || dish, rest.map((ph) => ph.url));
        if (weak.size) {
          const venue = photos.filter((ph) => ph.fromVenue);
          const strong = rest.filter((ph) => !weak.has(ph.url));
          const weakRest = rest.filter((ph) => weak.has(ph.url));
          photos = [...venue, ...strong, ...weakRest];
        }
      }
    } catch { /* best-effort */ }
    dbg.resultCount = photos.length;
    return { photos, usage, debug: dbg };
  };

  // Zdjęcia POGLĄDOWE (typ dania). Kolejność źródeł zależy od REPRESENTATIVE_CC_FIRST:
  //  • domyślnie (tryb testowy): Serper (Google Images, ~93% trafień) → Wikimedia → Openverse,
  //  • CC‑first (produkcja, legalnie bezpieczne): Wikimedia → Openverse (licencje CC/PD) → Serper.
  // Zbieramy ze WSZYSTKICH 3 źródeł (Serper + Wikimedia + Openverse) i sortujemy wg oceny vision.
  // REPRESENTATIVE_CC_FIRST wpływa już TYLKO na priorytet przy remisie (które źródło „wygrywa" tie).
  const CC_FIRST = process.env.REPRESENTATIVE_CC_FIRST === "1";
  async function representatives(verify: boolean): Promise<{ photos: OutPhoto[]; usage: Usage }> {
    const perSource = Math.max(num * 2, 6);
    // DOKŁADNE pytanie wysłane do każdej wyszukiwarki: Serper dokleja kuchnię (jak genericWebImages),
    // Wikimedia/Openverse szukają po samym terminie generycznym.
    // photo_query (genericTerm) jest CZYSTE (sam opis dania, BEZ kuchni — enrich już jej nie dokleja). Kuchnię
    // dokleja TU kod, gdy chcemy. „Serper (web)" = termin + kuchnia (kod dokleja); „Serper (web, proste)" =
    // sam termin (bez kuchni) — eksperyment „czy kuchnia w zapytaniu pomaga, czy zaśmieca".
    const serperQ = [genericTerm, cuisine?.trim()].filter(Boolean).join(" ");
    // Wikimedia/Openverse szukają po TYTULE/TEKŚCIE → pełny opisowy termin trafia w długie dokumenty (skany
    // książek kucharskich). Dajemy im sam RDZEŃ (pierwsze ~3 słowa); Serper (Google Images) zostaje z pełnym.
    const wikiTerm = shortTerm(genericTerm);
    const sources: { name: string; prov: string; step: ToggleStep; query: string; run: () => Promise<DishPhoto[]> }[] = [
      { name: "Serper (web)", prov: "serper", step: "photoSerper", query: serperQ, run: () => genericWebImages(genericTerm, perSource, cuisine) },
      { name: "Serper (web, proste, bez kuchni)", prov: "serper", step: "photoSerperPlain", query: genericTerm, run: () => genericWebImages(genericTerm, perSource) },
      { name: "Wikimedia", prov: "wikimedia", step: "photoWikimedia", query: wikiTerm, run: () => new WikimediaProvider(perSource).find(wikiTerm) },
      { name: "Openverse", prov: "openverse", step: "photoOpenverse", query: wikiTerm, run: () => new OpenverseProvider(perSource).find(wikiTerm) },
    ];
    // CC-first (produkcja): źródła licencji CC (Wikimedia/Openverse) najpierw, Serper na końcu — kolejność
    // wpływa tylko na priorytet przy remisie. Sortujemy po liście priorytetu (odporne na dodawanie źródeł).
    const ccOrder: ToggleStep[] = ["photoWikimedia", "photoOpenverse", "photoSerper", "photoSerperPlain"];
    // Pomiń źródła WYŁĄCZONE w configu (lab) — zero kosztu/zapytań dla wyłączonych (testy/oszczędność).
    const ordered = (CC_FIRST ? [...sources].sort((a, b) => ccOrder.indexOf(a.step) - ccOrder.indexOf(b.step)) : sources).filter((s) => stepEnabled(s.step));
    const lists = await Promise.all(ordered.map((s) => s.run().catch(() => [] as DishPhoto[])));
    const usedProviders = ordered.filter((_, i) => lists[i]!.length > 0).map((s) => s.name);
    // SUROWE wyniki per wyszukiwarka (pytanie + URL-e ZWRÓCONE przez API, PRZED weryfikacją vizją) — do
    // podglądu „o co pytaliśmy i co dała wyszukiwarka, zanim ocenialiśmy". Same linki (bez bajtów).
    // BEZ filtra pustych — pokaż też „0 zwróconych" (potwierdzenie, że wyszukiwarka odpowiedziała pustką,
    // a nie że był timeout/błąd; błędy API widać osobno z licznika błędów per provider).
    dbg.searched!.push(...ordered.map((s, i) => ({ provider: s.name, prov: s.prov, query: s.query, urls: (lists[i] ?? []).map((ph) => ph.url).filter(Boolean).slice(0, 12) })));
    // Scal RÓWNOMIERNIE (round-robin po źródłach), dedup po url — każde źródło ma reprezentację.
    const merged: DishPhoto[] = [];
    const seen = new Set<string>();
    const maxLen = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < maxLen; i++) for (const l of lists) {
      const ph = l[i];
      if (ph?.url && !seen.has(ph.url)) { seen.add(ph.url); merged.push(ph); }
    }
    // Sufit liczby zdjęć do WERYFIKACJI (koszt vision) — z 3 źródeł, ale bez rozdmuchania.
    const cands = merged.slice(0, Math.max(num * 3, 9));
    const provider = usedProviders.join(" + ") || ordered[0]!.name;
    const step: DbgStep = { tier: "Poglądowe (typ dania)", provider, query: genericTerm, returned: cands.length };
    dbg.steps.push(step);
    if (cands.length === 0) return { photos: [], usage: ZERO_USAGE };
    const srcOf = (ph: DishPhoto) => (ph.domain ? photoSourceCategory(ph.domain) : ph.source);
    if (!verify) {
      step.passed = Math.min(cands.length, num);
      step.candidates = candListOf(cands);
      return {
        photos: cands.slice(0, num).map((ph) => outPhoto(ph, { verified: false, representative: true, source: srcOf(ph) })),
        usage: ZERO_USAGE,
      };
    }
    const { scores, textOverlay, usage } = await scoreDishPhotos(genericTerm, cands.map((ph) => ph.url), { cuisine, model: verifyModel, noCache: p.noCache });
    const scored = cands.map((ph, i) => ({ ...ph, score: scores[i] ?? 0, textOverlay: !!textOverlay[i] }));
    step.candidates = candScoredOf(scored);
    const rs = (ph: { score: number; textOverlay?: boolean }) => ph.score - (ph.textOverlay ? 0.15 : 0);
    // ADDYTYWNIE: nic nie wyrzucamy z listy roboczej, tylko sortujemy wg jakości.
    const sorted = [...scored].sort((a, b) => rs(b) - rs(a));
    const good = sorted.filter((ph) => ph.score >= MATCH_THRESHOLD);
    const bad = sorted.filter((ph) => ph.score < MATCH_THRESHOLD);
    step.passed = good.length;
    // WSZYSTKIE które PRZESZŁY próg jakości — już je zweryfikowaliśmy (vision zapłacony), więc nie wyrzucamy
    // dobrych zdjęć do `num`. `num` steruje tylko PULĄ kandydatów (ile szukamy/oceniamy), nie obcina dobrych
    // wyników. Odrzucone (poniżej progu) zwracamy oznaczone tylko przy „bierz wszystko"/teście.
    const wantAll = !!p.takeAll || !!p.noCache;
    const mk = (ph: (typeof scored)[number], rejected: boolean) =>
      outPhoto(ph, { verified: false, representative: true, source: srcOf(ph), score: r2(ph.score), rejected: rejected || undefined });
    const goodOut = good.map((ph) => mk(ph, false));
    const badOut = wantAll ? bad.map((ph) => mk(ph, true)) : [];
    return { photos: [...goodOut, ...badOut], usage };
  }

  // CACHE ① zdjęć POGLĄDOWYCH (typ dania) — niezależnych od lokalu. Klucz: termin generyczny + model
  // weryfikacji + liczba kandydatów. Trafienie = zero płatnych wywołań (ani Serper, ani vision). Pomijany
  // przy noCache (LAB / porównania modeli).
  const reprCacheKey = (verifyFlag: boolean) =>
    reprPhotoCacheKey({ dish, photoQuery: p.photoQuery, cuisine, verifyModel, num, verify: verifyFlag, takeAll: p.takeAll });
  async function cachedRepresentatives(verifyFlag: boolean): Promise<{ photos: OutPhoto[]; usage: Usage; cached: boolean }> {
    const ck = reprCacheKey(verifyFlag);
    const hit = await cacheGet<OutPhoto[]>("repr-photos", ck, { op: "dish-photos", bypass: p.noCache });
    if (hit && hit.length) {
      const photos = hit.map((ph) => ({ ...ph, cached: true }));
      dbg.steps.push({
        tier: "Poglądowe (typ dania)", provider: "CACHE 🗄", query: genericTerm,
        returned: photos.length, passed: photos.length,
        // Z cache też niesiemy OCENĘ (OutPhoto.score) i werdykt → LAB pokazuje % jak przy świeżym skanie
        // (nie „?"). passed: w cache trzymamy zatwierdzony zbiór (rejected tylko przy takeAll/teście).
        candidates: photos.map((ph) => ({ url: ph.url, score: ph.score, passed: !ph.rejected, fromVenue: ph.fromVenue, fromVenueReason: ph.fromVenueReason })),
      });
      dbg.fromCache = true;
      return { photos, usage: ZERO_USAGE, cached: true };
    }
    // Do cache TYLKO dobre (nieodrzucone) — odrzucone zwracamy do podglądu (takeAll/test), ale nie zapisujemy,
    // dzięki czemu tryb „bierz wszystko" nie zanieczyszcza wpisu (i nie musi być w kluczu).
    const compute = async () => {
      const r = await representatives(verifyFlag);
      const toCache = r.photos.filter((ph) => !ph.rejected);
      if (toCache.length) void cacheSet("repr-photos", ck, toCache, { model: verifyModel });
      return r;
    };
    // SINGLE-FLIGHT: gdy wielu prosi na ZIMNO o ten sam termin (popularne danie), liczy TYLKO pierwszy —
    // reszta bierze jego zdjęcia, usage 0 (nie płacą 2× za Serper+vision). Pomijane przy noCache (LAB: świeże).
    if (p.noCache) {
      const { photos, usage } = await compute();
      return { photos, usage, cached: false };
    }
    const { promise, coalesced } = singleFlight(ck, compute);
    const { photos, usage } = await promise;
    return { photos, usage: coalesced ? ZERO_USAGE : usage, cached: coalesced };
  }

  // Tryb poglądowy (do tła po skanie): z cache albo Serper/Wikimedia/Openverse (weryfikowane).
  if (p.representativeOnly) {
    const { photos, usage } = await cachedRepresentatives(p.verify !== false);
    return await finish(photos, usage);
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
  // Dedup gotowych OutPhoto (np. z cache poglądowych) względem już zebranych zdjęć z lokalu.
  const freshOut = (list: OutPhoto[]) => list.filter((ph) => ph.url && !seen.has(dedupKey({ url: ph.url } as DishPhoto)) && seen.add(dedupKey({ url: ph.url } as DishPhoto)));

  // Akumulator wyniku — WSZYSTKIE zweryfikowane (zapłacone) zdjęcia, najlepsze (z lokalu) pierwsze. NIE
  // tniemy do `num` — `num` steruje tylko PULĄ kandydatów do oceny, nie wyrzucamy dobrych wyników.
  const result: OutPhoto[] = [];
  const pushPhotos = (ps: OutPhoto[]) => { for (const x of ps) result.push(x); };

  // Ocena do SORTOWANIA z karą za „wpalony tekst" (#3) — pin/przepis z napisem rankuje niżej niż
  // czyste zdjęcie jedzenia (ale nadal może przejść próg — to tylko kolejność, nie odrzucenie).
  type Scored = DishPhoto & { score: number; textOverlay?: boolean };
  const rankScore = (ph: Scored) => ph.score - (ph.textOverlay ? 0.15 : 0);

  // Weryfikacja listy → oceny + flaga „wpalony tekst" (dolicza koszt).
  async function verifyScored(list: DishPhoto[], term: string): Promise<Scored[]> {
    const { scores, textOverlay, usage } = await scoreDishPhotos(term, list.map((ph) => ph.url), { cuisine, model: verifyModel, noCache: p.noCache });
    total = addUsage(total, usage);
    return list.map((ph, i) => ({ ...ph, score: scores[i] ?? 0, textOverlay: !!textOverlay[i] }));
  }

  // Słabo dopasowane zdjęcia z WŁASNEJ strony lokalu (próg 0.45–0.6) — trzymane na koniec: lepsze
  // jest pewne (≥0.6) zdjęcie typu dania niż zły WARIANT z lokalu (np. białe lassi dla „mango lassi").
  let weakVenue: Scored[] = [];

  // ---- A. ZDJĘCIA Z LOKALU (#1) — tylko POTWIERDZONE (własna domena / d<id> TA / nazwa-w-URL). ----
  // DWA OSOBNE kroki Serper „z lokalu": strona www (site:domena) i portale/social — każdy własny toggle.
  if (!branded) {
    const venueCands: DishPhoto[] = [];
    if (restaurantDomain && stepEnabled("photoSerperSite")) {
      let site = await restaurantSiteImages(nameMenu, restaurantDomain, 6).catch(() => []);
      if (site.length === 0 && nameCanon !== nameMenu) site = await restaurantSiteImages(nameCanon, restaurantDomain, 6).catch(() => []);
      const siteFresh = fresh(site);
      dbg.steps.push({ tier: "Z lokalu — strona www", provider: `site:${restaurantDomain}`, query: nameMenu, returned: site.length, candidates: candListOf(siteFresh) });
      if (site.length) dbg.searched!.push({ provider: `site:${restaurantDomain}`, prov: "serper", query: nameMenu, urls: site.map((ph) => ph.url).filter(Boolean).slice(0, 12) });
      venueCands.push(...siteFresh);
    }
    const portal = stepEnabled("photoSerperPortal") ? await venuePortalImages([nameMenu, nameCanon, nameLocal], venueName, cityQual, 6).catch(() => []) : [];
    const portalFresh = fresh(portal);
    const portalQuery = `[${[nameMenu, nameCanon, nameLocal].filter(Boolean).join(" / ")}] ${[venueName, cityQual].filter(Boolean).join(" ")}`.trim();
    // #1: tylko POTWIERDZONE z lokalu (po URL/domenie/ID — bez vision) trafiają do puli „z lokalu";
    //     reszta z portali/social (cudze zdjęcia dania) jest pomijana — czysty generyk z B jest lepszy.
    const portalVenue = portalFresh.filter((ph) => fromVenue(ph));
    if (portal.length) dbg.searched!.push({ provider: "Serper portale/social", prov: "serper", query: portalQuery, urls: portal.map((ph) => ph.url).filter(Boolean).slice(0, 12) });
    dbg.steps.push({
      tier: "Z lokalu — portale/social",
      provider: "Serper site:portale+social",
      query: portalQuery,
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

  // ---- B. DOPEŁNIENIE POGLĄDOWE (#2) — generyk „typ dania" do `num`. Z CACHE ① albo na żywo. ----
  // Reprezentatywne zdjęcia są niezależne od lokalu → ten sam zestaw obsługuje wszystkie lokale;
  // tu tylko odsiewamy duplikaty względem już zebranych zdjęć z lokalu i bierzemy ile brakuje.
  async function fillRepresentative(): Promise<void> {
    const { photos, usage } = await cachedRepresentatives(verify);
    total = addUsage(total, usage);
    pushPhotos(freshOut(photos)); // wszystkie dobre poglądowe (po dedupie względem zdjęć z lokalu)
  }
  await fillRepresentative();

  // #1: słabe zdjęcia z WŁASNEJ strony lokalu (poniżej progu) — TYLKO jako fallback, gdy nie ma nic dobrego.
  if (result.length === 0 && weakVenue.length) {
    pushPhotos(weakVenue.map((ph) => outPhoto(ph, { verified: true, representative: false })));
  }

  return await finish(result, total);
}
