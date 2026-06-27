// CLIP on-device (Apple MobileCLIP, Core ML) — prymitywy + ZASTOSOWANIA aplikacyjne (poza benchmarkiem weryfikatorów).
// Wszystko best-effort, iOS only (Android/brak modułu → null/no-op). Patrz [[menubutbetter-photo-verifiers]].
import { Platform } from "react-native";

type ClipNative = {
  match(url: string, text: string): Promise<{ score: number } | null>;
  classify(url: string, labels: string[]): Promise<{ scores: { label: string; score: number }[] } | null>;
  embed(url: string): Promise<{ embedding: number[] } | null>;
  diag(): Promise<Record<string, unknown>>;
};

let _clip: ClipNative | null | undefined;
function clip(): ClipNative | null {
  if (_clip !== undefined) return _clip;
  if (Platform.OS !== "ios") { _clip = null; return null; }
  try { _clip = require("../modules/mobileclip/src/MobileClipModule").default as ClipNative; }
  catch { _clip = null; }
  return _clip;
}
export const clipAvailable = () => clip() != null;

// Diagnostyka (cache): co się załadowało w natywnym module (modele/tokenizer). Do debugu „czemu clip nie liczy".
let _diag: Record<string, unknown> | null | undefined;
export async function clipDiag(): Promise<Record<string, unknown> | null> {
  if (_diag !== undefined) return _diag;
  const c = clip();
  if (!c) { _diag = { moduleAvailable: false }; return _diag; }
  try { _diag = { moduleAvailable: true, ...(await c.diag()) }; } catch (e) { _diag = { moduleAvailable: true, diagError: String(e) }; }
  return _diag;
}

/** Prymityw: podobieństwo zdjęcie↔tekst (cosine). null = brak/błąd. */
export async function clipMatch(uri: string, text: string): Promise<number | null> {
  const c = clip(); if (!c) return null;
  try { const r = await c.match(uri, text); return r && typeof r.score === "number" ? r.score : null; } catch { return null; }
}
/** Prymityw: zero-shot klasyfikacja (cosine per etykieta), posortowane malejąco. */
export async function clipClassify(uri: string, labels: string[]): Promise<{ label: string; score: number }[] | null> {
  const c = clip(); if (!c) return null;
  try { const r = await c.classify(uri, labels); return r?.scores ? [...r.scores].sort((a, b) => b.score - a.score) : null; } catch { return null; }
}
/** Prymityw: embedding obrazu (znormalizowany L2) do podobieństwa obraz↔obraz. */
export async function clipEmbed(uri: string): Promise<number[] | null> {
  const c = clip(); if (!c) return null;
  try {
    const r = await c.embed(uri);
    if (!r?.embedding?.length) return null;
    let n = 0; for (const v of r.embedding) n += v * v; n = Math.sqrt(n) || 1;
    return r.embedding.map((v) => v / n);
  } catch { return null; }
}
const cos = (a: number[], b: number[]) => { let d = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) d += a[i]! * b[i]!; return d; };

// CLIP zero-shot „dobre RESTAURACYJNE zdjęcie tego dania": pozytywy (danie/danie restauracyjne/szklanka — dla napojów)
// kontra negatywy CELOWANE w realne błędy z danych (reklama/menu-tekst/produkt butelka-puszka/screenshot-z-napisem/
// listing-sklepowy). Score CIĄGŁY (nie saturujący softmax): (1) margin nad negatywami × (2) czy w ogóle pasuje (bestPos).
// Wybór promptów/score wynika z analizy zebranych werdyktów — patrz [[menubutbetter-photo-verifiers]].
const CLIP_NEG = [
  "an advertisement or product packaging",
  "a menu with text",
  "a product photo of bottles or cans on a plain background",
  "a social media screenshot with text overlay",
  "an online store product listing photo",
];
// Dla pozycji MARKOWYCH (branded: Coca-Cola, Bombay Sapphire…) poprawnym zdjęciem JEST produkt (butelka/puszka),
// więc NIE karzemy go negatywami produktowymi — pozytyw celuje w markę, negatywy tylko menu/screenshot/nie-na-temat.
const CLIP_NEG_BRANDED = ["a menu with text", "a social media screenshot with text overlay", "a random unrelated photo"];
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
// Prompty DIAGNOSTYCZNE (nie wpływają na score) — dokładane do klasyfikacji, by ZAPISAĆ więcej surowych cech per
// zdjęcie (jakość/kompozycja/treść) do późniejszej interpretacji offline, bez ponownego skanu. Apka testowa → OK.
const CLIP_DIAG = [
  "a professional appetizing food photo",
  "a blurry or low quality photo",
  "a close-up of a single dish on a plate",
  "a photo of several dishes on a table",
  "a photo with text, watermark or logo overlay",
  "the interior or exterior of a restaurant",
];
export async function clipDishScore(uri: string, dish: string, branded = false): Promise<{ score: number; bestPos: number; bestNeg: number; raw: { label: string; score: number }[] } | null> {
  const pos = branded
    ? [`a photo of ${dish}`, `a bottle or can of ${dish}`, `a product photo of ${dish}`]
    : [`a photo of ${dish}`, `a restaurant dish of ${dish}`, `a glass of ${dish}`];
  const neg = branded ? CLIP_NEG_BRANDED : CLIP_NEG;
  const all = [...pos, ...neg, ...CLIP_DIAG]; // diag tylko do ZAPISU surowych cosine (score liczony z pos/neg)
  const res = await clipClassify(uri, all);
  if (!res) return null;
  const m = new Map(res.map((r) => [r.label, r.score]));
  const bestPos = Math.max(...pos.map((p) => m.get(p) ?? 0));
  const bestNeg = Math.max(...neg.map((p) => m.get(p) ?? 0));
  // (1) sigmoid(12·margin): bije złe prompty; (2) sigmoid(20·(bestPos−0.18)): w ogóle pasuje do dania (woda/niedopasowane → niskie).
  // Stałe wstępne, dobrane na rozkładzie bestPos (min 0.169, śr 0.279) z zebranych werdyktów — do douczenia, gdy będą etykiety.
  const score = sigmoid(12 * (bestPos - bestNeg)) * sigmoid(20 * (bestPos - 0.18));
  return { score, bestPos, bestNeg, raw: res };
}

// GENERYCZNY food vs nie-food (do pre-filtra puli ★ z lokalu) — „czy to w ogóle zdjęcie potrawy", NIE dopasowanie do
// konkretnego dania. 0..1: wysokie = potrawa, niskie = szyld/wnętrze/ludzie/menu/logo. Sygnał lokalny → serwer decyduje.
const FOOD_POS = ["a photo of a plated food dish", "a close-up of a prepared meal", "a serving of food on a plate", "an appetizing restaurant dish"];
const FOOD_NEG = ["a storefront or restaurant exterior", "a restaurant interior with empty tables", "a group of people", "a menu page with text", "a logo or sign", "a screenshot or document"];
export async function clipFoodScore(uri: string): Promise<number | null> {
  const res = await clipClassify(uri, [...FOOD_POS, ...FOOD_NEG]);
  if (!res) return null;
  const m = new Map(res.map((r) => [r.label, r.score]));
  const bestPos = Math.max(...FOOD_POS.map((p) => m.get(p) ?? 0));
  const bestNeg = Math.max(...FOOD_NEG.map((p) => m.get(p) ?? 0));
  return sigmoid(12 * (bestPos - bestNeg)) * sigmoid(20 * (bestPos - 0.18));
}

// JEDEN embed obrazu → food-score (jak wyżej) ORAZ ranking dopasowania do KONKRETNYCH dań (surowy cosine zdjęcie↔nazwa).
// Per-danie = SYGNAŁ do porównania CLIP vs płatna wizja (czy CLIP sam wystarcza). Tani, bo obraz embeduje się raz.
export async function clipFoodAndDish(uri: string, dishNames: string[]): Promise<{ food: number; dishes: { dish: string; cos: number }[] } | null> {
  const res = await clipClassify(uri, [...FOOD_POS, ...FOOD_NEG, ...dishNames.map((d) => `a photo of ${d}`)]);
  if (!res) return null;
  const m = new Map(res.map((r) => [r.label, r.score]));
  const bestPos = Math.max(...FOOD_POS.map((p) => m.get(p) ?? 0));
  const bestNeg = Math.max(...FOOD_NEG.map((p) => m.get(p) ?? 0));
  const food = sigmoid(12 * (bestPos - bestNeg)) * sigmoid(20 * (bestPos - 0.18));
  const dishes = dishNames.map((d) => ({ dish: d, cos: m.get(`a photo of ${d}`) ?? 0 })).sort((a, b) => b.cos - a.cos);
  return { food, dishes };
}

// Prompty zero-shot do analizy ZDJĘCIA MENU (przed skanem) — A typ / B jakość / C kuchnia / D kontekst-front.
// Zapisujemy surowe cosine per prompt (bez interpretacji); interpretację robimy potem w LABie.
export const MENU_PROMPTS = [
  // A. typ obrazu
  "a restaurant menu", "a printed menu page with dishes and prices", "a single dish or plate of food",
  "a drinks or wine list", "a receipt or bill", "a sign, poster or advertisement", "a random photo, not a menu",
  // B. jakość / czytelność
  "a sharp, well-lit, readable menu", "a blurry or out-of-focus menu", "a dark or underexposed menu photo", "a menu photographed at a steep angle",
  // C. kuchnia (eksperymentalne)
  "an italian menu", "a japanese or sushi menu", "a chinese or asian menu", "an indian menu", "a mexican menu",
  "a thai menu", "a french menu", "a fast food menu", "a cafe or coffee menu", "a bar or cocktail menu",
  // D. kontekst / front lokalu
  "a restaurant storefront or building exterior", "a restaurant sign or banner with the restaurant name",
  "a chalkboard or sidewalk menu board", "the interior of a restaurant or cafe", "a street with shops and signs",
];
/** Surowy CLIP dla zdjęcia MENU: cosine per prompt (bez interpretacji). null = CLIP niedostępny. */
export async function clipMenuRaw(uri: string): Promise<{ text: string; cos: number }[] | null> {
  const res = await clipClassify(uri, MENU_PROMPTS);
  return res ? res.map((r) => ({ text: r.label, cos: Math.round(r.score * 10000) / 10000 })) : null;
}

// ── #1: PRE-FILTR „czy to menu" PRZED płatnym skanem ──────────────────────────────────────────
// Zero-shot: czy zrobione zdjęcie WYGLĄDA na kartę menu (vs talerz/paragon/losowe). CLIP rozpoznaje UKŁAD
// wizualny (nie czyta tekstu), więc kartka menu vs talerz/krajobraz/paragon — daje radę. Margines, by nie straszyć.
const MENU_POS = ["a restaurant menu", "a printed food menu page", "a list of dishes and prices"];
const MENU_NEG = ["a plate of food", "a photo of a meal", "a receipt", "a random photo", "a landscape", "a person", "a sign or logo"];
export async function clipLooksLikeMenu(uri: string): Promise<{ isMenu: boolean; menu: number; other: number; confident: boolean } | null> {
  const scores = await clipClassify(uri, [...MENU_POS, ...MENU_NEG]);
  if (!scores) return null;
  const m = (set: string[]) => Math.max(...scores.filter((s) => set.includes(s.label)).map((s) => s.score), -1);
  const menu = m(MENU_POS), other = m(MENU_NEG);
  // „pewnie nie menu" tylko gdy negatyw WYRAŹNIE wygrywa — inaczej nie blokujemy (false-pozytywy drogie w UX).
  return { isMenu: menu >= other, menu, other, confident: other - menu > 0.03 };
}

// ── #3 + #4: DEDUP + RE-RANKING zdjęć dania (image↔image + image↔nazwa) ───────────────────────
// Najpierw embedy obrazów: odrzuć near-duplikaty (cosine > próg). Potem uszereguj wg dopasowania do nazwy dania
// (clipMatch). Best-effort: gdy CLIP niedostępny lub błąd → zwróć wejście bez zmian (kolejność oryginalna).
export async function clipRefinePhotos<T extends { url?: string }>(dishName: string, photos: T[]): Promise<T[]> {
  const c = clip();
  if (!c || photos.length < 2) return photos;
  try {
    const urls = photos.map((p) => p.url).filter((u): u is string => !!u && /^https?:\/\//i.test(u));
    if (urls.length < 2) return photos;
    const embs = await Promise.all(urls.map((u) => clipEmbed(u)));
    // dedup: zachowaj pierwsze wystąpienie, odrzuć bliźniaki
    const keepUrl = new Set<string>();
    const kept: string[] = [];
    const keptEmb: number[][] = [];
    urls.forEach((u, i) => {
      const e = embs[i];
      if (e && keptEmb.some((k) => cos(k, e) > 0.96)) return; // near-duplikat
      keepUrl.add(u); kept.push(u); if (e) keptEmb.push(e);
    });
    // ranking wg dopasowania do nazwy
    const matchScore = new Map<string, number>();
    await Promise.all(kept.map(async (u) => { const s = await clipMatch(u, `a photo of ${dishName}`); matchScore.set(u, s ?? -1); }));
    const survivors = photos.filter((p) => p.url && keepUrl.has(p.url));
    const rest = photos.filter((p) => !p.url || !/^https?:\/\//i.test(p.url)); // bez url (np. google proxy) — zostaw na końcu, bez zmian
    survivors.sort((a, b) => (matchScore.get(b.url!) ?? -1) - (matchScore.get(a.url!) ?? -1));
    return [...survivors, ...rest];
  } catch {
    return photos;
  }
}
