// Scalanie nowo zeskanowanych stron z istniejącym menu — deterministycznie, po stronie
// klienta. Zachowuje istniejące pozycje (z ich zdjęciami/opisami) NIETKNIĘTE, dokłada
// tylko genuinnie nowe, uzupełnia brakującą nazwę/adres/kuchnię, i NIE duplikuje dań.
import type { Menu, MenuSection } from "./types";

/** Normalizacja nazwy do porównań (bez diakrytyków, znaków i wielkości liter). */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameSection(a: MenuSection, b: MenuSection): boolean {
  return (
    (!!a.name && normName(a.name) === normName(b.name)) ||
    (!!a.name_translated && normName(a.name_translated) === normName(b.name_translated))
  );
}

export interface MergeResult {
  menu: Menu;
  addedItems: number;
  addedSections: number;
}

/** Dokłada `incoming` do `base`. Istniejące pozycje zostają bez zmian (zachowują zdjęcia). */
export function mergeMenus(base: Menu, incoming: Menu): MergeResult {
  // Płytka kopia sekcji + ich list (nie ruszamy samych obiektów pozycji bazowych).
  const sections: MenuSection[] = base.sections.map((s) => ({ ...s, items: [...s.items] }));

  // Zbiór już znanych dań (po znormalizowanej nazwie oryginalnej) — klucz deduplikacji.
  const seen = new Set<string>();
  for (const s of sections) for (const it of s.items) seen.add(normName(it.original));

  let addedItems = 0;
  let addedSections = 0;

  for (const inSec of incoming.sections) {
    let target = sections.find((s) => sameSection(s, inSec));
    let isNewSection = false;
    if (!target) {
      target = { name: inSec.name, name_translated: inSec.name_translated, items: [] };
      isNewSection = true;
    }
    for (const it of inSec.items) {
      const key = normName(it.original);
      if (!key || seen.has(key)) continue; // pusta nazwa albo duplikat → pomiń
      seen.add(key);
      target.items.push(it);
      addedItems++;
    }
    if (isNewSection && target.items.length > 0) {
      sections.push(target);
      addedSections++;
    }
  }

  const menu: Menu = {
    ...base,
    // Uzupełnij brakujące pola kontekstu, jeśli nowe zdjęcia je ujawniły.
    restaurant_name: base.restaurant_name ?? incoming.restaurant_name,
    restaurant_address: base.restaurant_address ?? incoming.restaurant_address,
    cuisine: base.cuisine ?? incoming.cuisine,
    sections,
  };
  return { menu, addedItems, addedSections };
}
