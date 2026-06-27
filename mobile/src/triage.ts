// TRIAŻ zdjęcia wejściowego: do jakiej GRUPY trafia (menu / szyld-lokal / danie / śmieć / niepewne) — wyliczany NA ŻYWO
// z już zebranych sygnałów (OCR + menu-AI), bez uruchamiania modeli ponownie. Lekki: bazuje na OCR (najmocniejszy
// sygnał „czy to menu" — gęsty, strukturalny tekst + ceny) i Apple Vision (scena: jedzenie/budynek); CLIP TYLKO
// pomocniczo. Patrz [[menubutbetter-photo-verifiers]]. Etykieta służy do oceny w terenie i (opcjonalnie) routingu skanu.
import type { OcrData } from "./menuRegion";
import type { MenuAi } from "./photoEval";

export type TriageGroup = "menu" | "sign" | "dish" | "junk" | "unsure";
export interface TriageResult { group: TriageGroup; label: string; emoji: string; why: string }

const META: Record<TriageGroup, { label: string; emoji: string }> = {
  menu: { label: "menu", emoji: "📋" },
  sign: { label: "szyld/lokal", emoji: "🪧" },
  dish: { label: "danie", emoji: "🍽️" },
  junk: { label: "śmieć?", emoji: "🗑️" },
  unsure: { label: "niepewne", emoji: "❔" },
};
const PRICE_RE = /(\d+[.,]\d{2})|(\d+\s?(zł|pln|eur|usd|gbp|€|\$|£))/i;
const r = (g: TriageGroup, why: string): TriageResult => ({ group: g, ...META[g], why });

/** Grupa triażu z OCR (+ opcjonalnie menu-AI). Bez menu-AI degraduje do samego OCR (menu vs nie-menu). */
export function triageGroup(ocr?: OcrData | null, menuAi?: MenuAi | null): TriageResult {
  // 1) OCR: gęsty, strukturalny tekst lub ceny → MENU (najpewniejszy, modelo-niezależny)
  let lines = 0, words = 0, prices = 0;
  if (ocr) for (const b of ocr.blocks) { lines += b.lines.length; for (const l of b.lines) { words += l.words?.length ?? 0; if (PRICE_RE.test(l.text)) prices++; } }
  if (lines >= 8 || prices >= 2) return r("menu", `OCR ${lines} linii, ${prices} cen`);

  // 2) scena z Apple Vision (lekki) + CLIP pomocniczo
  const appleLabels = (menuAi?.appleVision?.labels ?? []).map((l) => l.text.toLowerCase());
  const hasA = (kws: string[]) => appleLabels.some((t) => kws.some((k) => t.includes(k)));
  const food = hasA(["food", "dish", "meal", "plate", "drink", "cuisine", "dessert", "produce", "fruit", "vegetable"]);
  const building = hasA(["building", "outdoor", "facade", "storefront", "house", "architecture", "street", "sign", "door", "window"]);
  const clip = menuAi?.clip?.prompts ?? [];
  const cmax = (subs: string[]) => Math.max(-1, ...clip.filter((p) => subs.some((s) => p.text.includes(s))).map((p) => p.cos));
  const cSign = cmax(["storefront", "sign or banner", "street with shops"]);
  const cDish = cmax(["single dish or plate"]);
  const cMenu = cmax(["a restaurant menu", "printed menu page"]);

  // 3) prawie brak tekstu → danie / szyld / śmieć
  if (lines <= 2 && words <= 3) {
    if (food || cDish > cSign + 0.02) return r("dish", "brak tekstu + jedzenie");
    if (building || cSign > cDish + 0.02) return r("sign", "brak tekstu + scena lokalu");
    return r("junk", "brak tekstu i sceny");
  }
  // 4) trochę tekstu (3–7 linii, bez cen): szyld z nazwą? częściowe menu?
  if (building && lines <= 4) return r("sign", "mało tekstu + scena lokalu");
  if (cMenu > 0.22 || lines >= 5) return r("menu", "umiarkowany tekst (menu?)");
  return r("unsure", `${lines} linii, brak cen`);
}

/** Czy zdjęcie warto wysłać do modelu czytającego KARTĘ (menu/niepewne tak; danie/szyld/śmieć — nie). */
export function triagePassesToScan(t: TriageResult): boolean {
  return t.group === "menu" || t.group === "unsure";
}

/** Lokalny HINT nazwy lokalu z OCR podanych zdjęć (zwykle ODRZUCONYCH szyldów/frontów): krótka „nazwopodobna" linia
 *  (1–4 słowa, wyżej i większa = lepiej), bez cen/„menu"/długich. NIEPEWNE — to tylko podpowiedź dla modelu; karta
 *  i tak jest pierwszym/najczęstszym źródłem nazwy, a model ma ją potwierdzić, nie ufać 100%. null = brak kandydata. */
export function harvestVenueName(photos: { ocr?: OcrData | null }[]): string | null {
  const SKIP = /(\d{2,})|[€$£]|(\bz[łl]\b)|\bmenu\b|\bcarta\b|\bspeisekarte\b|\bla carte\b/i;
  let best: { text: string; score: number } | null = null;
  for (const p of photos) {
    if (!p.ocr) continue;
    for (const b of p.ocr.blocks) for (const l of b.lines) {
      const t = (l.text || "").trim();
      const words = t.split(/\s+/).filter(Boolean).length;
      if (t.length < 3 || words < 1 || words > 4 || SKIP.test(t)) continue;
      const y = l.frame?.y ?? 0.5; // 0 = góra
      const h = l.frame?.h ?? 0;   // większy tekst = nazwa/logo
      const score = (1 - y) * 0.6 + h * 12 + (words <= 2 ? 0.25 : 0);
      if (!best || score > best.score) best = { text: t, score };
    }
  }
  return best?.text ?? null;
}
