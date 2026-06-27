// BENCHMARK lokalnych weryfikatorów zdjęć dań — patrz [[menubutbetter-photo-verifiers]]. Każdy weryfikator
// ocenia te same zdjęcia (URL z wyszukiwarki), wynik leci na serwer (POST /photo-feedback) i porównujesz w LABie.
// Apka jest TESTOWA → odpalamy wszystkie dostępne bez opt-in. Weryfikatory:
//  • mlkit-label   — ML Kit Image Labeling (cross-platform; remote URL pobiera natywnie).
//  • apple-vision  — natywny moduł Apple Vision (iOS only; klasyfikacja + estetyka/isUtility).
//  • (clip — Faza 3).
import ImageLabeling from "@react-native-ml-kit/image-labeling";
import { Platform } from "react-native";
import { clipDishScore, clipDiag, clipMenuRaw, clipFoodScore, clipFoodAndDish } from "./clip";

export interface PhotoVerdict {
  dish: string;   // tożsamość po stronie wyszukiwania (photo_query/nazwa dania) — klucz grupowania w LABie
  url: string;
  evaluator: string; // "mlkit-label" | "apple-vision" | "clip" | ...
  score: number;  // 0..1 — tu „czy to wygląda na DANIE/jedzenie"
  label?: string; // najmocniejsza etykieta (kontekst)
  meta?: unknown; // surowe top-etykiety do analizy
}

type RawLabel = { text: string; confidence: number };

// Słowa-klucze JEDZENIA — substring na etykietach (ML Kit i Vision mają różne taksonomie; „_"→spacja). Score =
// max confidence wśród etykiet jedzeniowych. To „czy to w ogóle danie", NIE dopasowanie do nazwy (od tego CLIP).
const FOOD_KW = [
  "food", "dish", "cuisine", "dessert", "meal", "fruit", "vegetable", "bread", "baked", "pastry", "pie",
  "drink", "cocktail", "juice", "coffee", "tea", "wine", "beer", "beverage", "soup", "salad", "pizza",
  "pasta", "rice", "noodle", "meat", "steak", "seafood", "fish", "cheese", "cake", "ice cream", "chocolate",
  "sushi", "sandwich", "burger", "taco", "curry", "breakfast", "lunch", "dinner", "snack", "plate", "bowl",
  "tableware", "recipe", "produce",
];
// GRAFIKA/NIE-ZDJĘCIE (kara): text/logo/poster/screenshot/menu/ilustracja/dokument — łapie kolaże produktowe,
// loga, zrzuty, karty menu, które „są o jedzeniu", więc sam food-score je przepuszczał.
const GRAPHIC_KW = [
  "text", "font", "logo", "brand", "poster", "advertis", "screenshot", "illustration", "cartoon", "clip art",
  "graphic", "diagram", "document", "paper", "menu", "sign", "banner", "label", "sticker", "drawing", "painting",
];
// OSOBA (kara): zdjęcie z osobą/selfie to nie czyste zdjęcie dania.
const PERSON_KW = ["person", "selfie", "face", "people", "human", "portrait"];
// Stopwords z nazwy dania (do dopasowania etykiet); reszta słów ≥3 znaki.
const NAME_STOP = new Set(["a", "an", "the", "of", "with", "and", "or", "in", "on", "de", "la", "le", "el", "con", "do", "da", "ze", "na", "the"]);

function maxByKw(labels: RawLabel[], kws: string[]): { score: number; top?: string } {
  let best = 0; let top: string | undefined;
  for (const l of labels) { const t = l.text.toLowerCase().replace(/_/g, " "); if (kws.some((k) => t.includes(k)) && l.confidence > best) { best = l.confidence; top = l.text; } }
  return { score: best, top };
}
function nameMatch(dish: string, labels: RawLabel[]): { score: number; word?: string } {
  const words = dish.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3 && !NAME_STOP.has(w));
  let best = 0; let word: string | undefined;
  for (const l of labels) { const t = l.text.toLowerCase(); for (const w of words) { if ((t.includes(w) || w.includes(t)) && l.confidence > best) { best = l.confidence; word = l.text; } } }
  return { score: best, word };
}
// KOMPOZYTOWY wynik „dobre zdjęcie TEGO dania" z sygnałów klasyfikatora (food + grafika/osoba/nazwa + estetyka/utility).
function compositeScore(dish: string, labels: RawLabel[], opt: { isUtility?: boolean; aesthetics?: number; branded?: boolean } = {}): { score: number; label: string; comp: Record<string, unknown> } {
  const food = maxByKw(labels, FOOD_KW);
  const graphic = maxByKw(labels, GRAPHIC_KW);
  const person = maxByKw(labels, PERSON_KW);
  const nm = nameMatch(dish, labels);
  let s = food.score - 0.7 * graphic.score - 0.4 * person.score + 0.25 * nm.score;
  // weto: Apple isUtility łapie grafiki/produkty (potwierdzone 6/6 w danych) — ALE dla MARKOWYCH produkt to poprawne zdjęcie, więc nie wetujemy.
  if (opt.isUtility && !opt.branded) s = Math.min(s, 0.03);
  if (typeof opt.aesthetics === "number") s += 0.1 * Math.max(-1, Math.min(1, opt.aesthetics));
  s = Math.max(0, Math.min(1, s));
  // Czytelna etykieta w LABie — DLACZEGO taki wynik:
  let label: string;
  if (opt.isUtility) label = `⚠ utility (grafika)`;
  else if (nm.word) label = `✓ pasuje: ${nm.word}`;
  else if (graphic.score > 0.4 && graphic.score > food.score) label = `⚠ grafika (${graphic.top})`;
  else if (person.score > 0.4) label = `⚠ osoba`;
  else label = food.top ?? labels[0]?.text ?? "—";
  return { score: s, label, comp: { food: +food.score.toFixed(2), graphic: +graphic.score.toFixed(2), person: +person.score.toFixed(2), nameMatch: +nm.score.toFixed(2), nameWord: nm.word ?? null, aesthetics: opt.aesthetics ?? null, isUtility: opt.isUtility ?? null } };
}

/** ML Kit Image Labeling → kompozytowy wynik „dobre zdjęcie tego dania" (food − grafika/osoba + dopasowanie nazwy).
 *  meta.raw = SUROWE wejście/wyjście modelu (bez interpretacji) do dopracowania w LABie; comp = nasza interpretacja. */
export async function evalMlkitLabel(dish: string, url: string): Promise<PhotoVerdict | null> {
  try {
    const labels = await ImageLabeling.label(url);
    const { score, label, comp } = compositeScore(dish, labels);
    const raw = { query: "image classification (no text query)", response: { labels: labels.map((l) => ({ text: l.text, conf: Math.round(l.confidence * 1000) / 1000 })) } };
    return { dish, url, evaluator: "mlkit-label", score, label, meta: { raw, comp } };
  } catch {
    return null;
  }
}

// Natywny moduł Apple Vision ładowany LENIWIE (iOS only; na Androidzie/braku modułu → null, weryfikator pomijany).
type AppleVisionNative = { analyze(url: string): Promise<{ labels: RawLabel[]; aesthetics?: number; isUtility?: boolean } | null> };
let _appleVision: AppleVisionNative | null | undefined;
function appleVision(): AppleVisionNative | null {
  if (_appleVision !== undefined) return _appleVision;
  if (Platform.OS !== "ios") { _appleVision = null; return null; }
  try { _appleVision = require("../modules/apple-vision/src/AppleVisionModule").default as AppleVisionNative; }
  catch { _appleVision = null; }
  return _appleVision;
}

/** Apple Vision (natywny, iOS): klasyfikacja jedzenia + isUtility (grafika/dokument → nie danie). null = niedostępny/błąd. */
export async function evalAppleVision(dish: string, url: string, branded = false): Promise<PhotoVerdict | null> {
  const av = appleVision();
  if (!av) return null;
  try {
    const r = await av.analyze(url);
    if (!r) return null;
    const labels = r.labels ?? [];
    const { score, label, comp } = compositeScore(dish, labels, { isUtility: r.isUtility, aesthetics: r.aesthetics, branded });
    const raw = { query: "image classification + aesthetics (no text query)", response: { labels: labels.map((l) => ({ text: l.text, conf: Math.round(l.confidence * 1000) / 1000 })), aesthetics: r.aesthetics ?? null, isUtility: r.isUtility ?? null } };
    return { dish, url, evaluator: "apple-vision", score, label, meta: { raw, comp } };
  } catch {
    return null;
  }
}

/** CLIP (MobileCLIP, iOS): podobieństwo zdjęcie↔nazwa dania. cosine (~ -0.1..0.35) → skalowane do 0..1.
 *  DIAGNOSTYKA: zawsze zwraca werdykt `clip` — przy błędzie z powodem + stanem modułu (diag), żeby w LABie było
 *  WIDAĆ, że CLIP w ogóle ruszył i gdzie pada (zamiast cichego null = brak kolumny). */
export async function evalClip(dish: string, url: string, branded = false): Promise<PhotoVerdict | null> {
  const r = await clipDishScore(url, dish, branded);
  if (r == null) {
    const d = await clipDiag();
    const short = d ? Object.entries(d).filter(([, v]) => v === false || v === "MISSING").map(([k]) => k).join(",") || "match=null" : "no-diag";
    return { dish, url, evaluator: "clip", score: 0, label: `BŁĄD: ${short}`, meta: { err: true, diag: d } };
  }
  // wynik = ciągły score (margin × bestPos-floor); etykieta pokazuje surowe cosine pos/neg
  const label = `${branded ? "marka " : "dish "}${Math.round(r.score * 100)}% (poz ${r.bestPos.toFixed(2)}/neg ${r.bestNeg.toFixed(2)})`;
  const posQ = branded ? [`a photo of ${dish}`, `a bottle or can of ${dish}`, `a product photo of ${dish}`] : [`a photo of ${dish}`, `a restaurant dish of ${dish}`, `a glass of ${dish}`];
  const raw = { query: [...posQ, branded ? "…+negatywy branded (menu/screenshot/unrelated)" : "…+5 negatywów (packaging/menu/bottles-cans/screenshot/store-listing)"], response: { cosines: r.raw } };
  return { dish, url, evaluator: "clip", score: r.score, label, meta: { raw, dishScore: r.score, bestPos: r.bestPos, bestNeg: r.bestNeg } };
}

/** PRE-FILTR puli ★ z lokalu: „czy to zdjęcie POTRAWY" WSZYSTKIMI lokalnymi modelami (CLIP food-vs-nie-food, Apple
 *  Vision food-labels − isUtility, ML Kit food-labels). Zwraca sygnały per model 0..1 + surowe (do wysłania na serwer —
 *  SERWER decyduje, co przepuścić do płatnej wizji). To NIE jest dopasowanie do dania (to robi płatna wizja na serwerze). */
export interface VenuePoolFood { clipFood?: number; appleFood?: number; mlkitFood?: number; clipDishes?: { dish: string; cos: number }[]; raw: Record<string, unknown> }
export async function venuePoolFood(url: string, dishNames?: string[]): Promise<VenuePoolFood> {
  let clipFood: number | undefined, appleFood: number | undefined, mlkitFood: number | undefined, clipDishes: { dish: string; cos: number }[] | undefined;
  const raw: Record<string, unknown> = {};
  const wantDish = !!(dishNames && dishNames.length);
  // równolegle: CLIP (food + opcjonalnie per-danie, JEDEN embed obrazu) + Apple + ML Kit
  const [clipR, appleR, mlkitR] = await Promise.all([
    wantDish ? clipFoodAndDish(url, dishNames!).catch(() => null) : clipFoodScore(url).then((f) => (f == null ? null : { food: f, dishes: [] as { dish: string; cos: number }[] })).catch(() => null),
    (async () => { const av = appleVision(); if (!av) return null; try { return await av.analyze(url); } catch { return null; } })(),
    (async () => { try { return await ImageLabeling.label(url); } catch { return null; } })(),
  ]);
  if (clipR) { clipFood = clipR.food; if (wantDish) { clipDishes = clipR.dishes.slice(0, 3); raw.clip = { food: +clipR.food.toFixed(3), top: clipDishes.map((d) => ({ dish: d.dish, cos: +d.cos.toFixed(3) })) }; } else raw.clip = +clipR.food.toFixed(3); }
  if (appleR) { const f = maxByKw(appleR.labels ?? [], FOOD_KW).score; appleFood = appleR.isUtility ? Math.min(f, 0.05) : f; raw.apple = { food: +f.toFixed(3), isUtility: appleR.isUtility ?? null, labels: (appleR.labels ?? []).slice(0, 8).map((l) => ({ text: l.text, conf: Math.round(l.confidence * 1000) / 1000 })) }; }
  if (mlkitR) { mlkitFood = maxByKw(mlkitR, FOOD_KW).score; raw.mlkit = { food: +mlkitFood.toFixed(3), labels: mlkitR.slice(0, 8).map((l) => ({ text: l.text, conf: Math.round(l.confidence * 1000) / 1000 })) }; }
  return { clipFood, appleFood, mlkitFood, clipDishes, raw };
}

/** Uruchamia WSZYSTKIE dostępne weryfikatory na jednym zdjęciu (równolegle). `branded` = pozycja markowa (produkt OK). */
export async function evaluatePhoto(dish: string, url: string, branded = false): Promise<PhotoVerdict[]> {
  const results = await Promise.all([evalMlkitLabel(dish, url), evalAppleVision(dish, url, branded), evalClip(dish, url, branded)]);
  return results.filter((v): v is PhotoVerdict => v != null);
}

/** Ocena zdjęć dania DO RANKINGU/ODSIEWU + benchmark w jednym przebiegu (1× CLIP+Apple per zdjęcie, bez dublowania).
 *  Zwraca: `scores` (url→{score, drop}) do sortowania/filtrowania W APCE oraz `verdicts` do wysłania na serwer.
 *  `drop` = grafika/produkt (Apple isUtility, gdy NIE branded) ALBO bardzo niski CLIP — ZAWSZE zostaw ≥1 (decyduje caller).
 *  `score` = przeliczony clipDishScore (branded-aware). Zdjęcia z LOKALU (★) caller pomija (nie rankuje/nie odrzuca). */
export type RankPhoto = { url: string; fromVenue?: boolean; domain?: string; source?: string; contextUrl?: string };
export async function scoreDishPhotosForRank(dish: string, photos: RankPhoto[], opts: { branded?: boolean; photoQuery?: string; fullName?: string } = {}): Promise<{ scores: Map<string, { score: number; drop: boolean }>; verdicts: PhotoVerdict[] }> {
  const branded = !!opts.branded;
  const scores = new Map<string, { score: number; drop: boolean }>();
  const verdicts: PhotoVerdict[] = [];
  for (const p of photos) {
    const vs = await evaluatePhoto(dish, p.url, branded);
    // KONTEKST per zdjęcie doklejony do KAŻDEGO werdyktu → na serwerze mamy komplet do interpretacji offline (bez re-skanu).
    const ctx = { branded, fromVenue: !!p.fromVenue, domain: p.domain ?? null, source: p.source ?? null, contextUrl: p.contextUrl ?? null, photoQuery: opts.photoQuery ?? dish, fullName: opts.fullName ?? null };
    for (const v of vs) v.meta = { ...(v.meta && typeof v.meta === "object" ? (v.meta as object) : {}), ctx };
    verdicts.push(...vs);
    const clip = vs.find((v) => v.evaluator === "clip");
    const apple = vs.find((v) => v.evaluator === "apple-vision");
    const isUtility = !!((apple?.meta as { raw?: { response?: { isUtility?: boolean } } } | undefined)?.raw?.response?.isUtility);
    const clipErr = !clip || ((clip.meta as { err?: boolean } | undefined)?.err === true); // CLIP niedostępny/błąd → NIE używaj jego score do odrzucania
    const score = typeof clip?.score === "number" ? clip.score : 0;
    // odrzuć: grafika/produkt (Apple isUtility, gdy !branded) LUB prawie-zero CLIP — ale TYLKO gdy CLIP realnie policzył
    // (inaczej brak CLIP zerowałby score wszystkich → odrzucone wszystko → 1 zdjęcie/danie). Brak modeli = brak odsiewu.
    const drop = (isUtility && !branded) || (!clipErr && score < 0.2);
    scores.set(p.url, { score, drop });
  }
  return { scores, verdicts };
}

// ── ANALIZA ZDJĘCIA MENU (przed skanem) — surowe wyniki każdego lokalnego modelu, BEZ interpretacji ──────────────
// To NIE jest weryfikacja zdjęcia dania (talerz). Tu oceniamy KARTĘ menu zrobioną przez usera: czy to menu / jakość /
// kuchnia / front lokalu. Zapisujemy surowo (mlkit etykiety, apple etykiety+estetyka, clip cosine per prompt) —
// interpretację (punkty/decyzje) robimy potem w LABie na zebranych danych. Patrz [[menubutbetter-photo-verifiers]].
export type MenuAi = {
  mlkit: { labels: { text: string; conf: number }[] } | null;
  appleVision: { labels: { text: string; conf: number }[]; aesthetics: number | null; isUtility: boolean | null } | null;
  clip: { prompts: { text: string; cos: number }[] } | null;
  at: number; // epoch ms — kiedy policzono (wersjonowanie/diagnostyka)
};

/** Analiza jednego ZDJĘCIA MENU wszystkimi dostępnymi lokalnymi modelami → SUROWE wyniki (null per model = niedostępny). */
export async function analyzeMenuPhoto(uri: string): Promise<MenuAi> {
  const [mlkit, av, cl] = await Promise.all([
    ImageLabeling.label(uri)
      .then((ls) => ({ labels: ls.map((l) => ({ text: l.text, conf: Math.round(l.confidence * 1000) / 1000 })) }))
      .catch(() => null),
    (async () => {
      const a = appleVision();
      if (!a) return null;
      try {
        const r = await a.analyze(uri);
        return r ? { labels: (r.labels ?? []).map((l) => ({ text: l.text, conf: Math.round(l.confidence * 1000) / 1000 })), aesthetics: r.aesthetics ?? null, isUtility: r.isUtility ?? null } : null;
      } catch { return null; }
    })(),
    clipMenuRaw(uri).then((p) => (p ? { prompts: p } : null)).catch(() => null),
  ]);
  return { mlkit, appleVision: av, clip: cl, at: Date.now() };
}

export const EVAL_PLATFORM = Platform.OS; // "ios" / "android" — tag platformy na serwerze
