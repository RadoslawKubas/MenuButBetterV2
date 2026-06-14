// JSON Schema wyniku odczytu menu (structured outputs Claude).
// Trzyma się ograniczeń structured outputs: każdy obiekt ma additionalProperties:false,
// wszystkie pola w `required`, pola opcjonalne są nullable (type: [..., "null"]).
// Bez minLength/maximum itp. — te ograniczenia nie są wspierane.

export const DISH_CATEGORIES = [
  "starter",
  "soup",
  "salad",
  "main",
  "side",
  "pasta",
  "pizza",
  "seafood",
  "dessert",
  "drink",
  "other",
] as const;

export type DishCategory = (typeof DISH_CATEGORIES)[number];

export interface MenuItem {
  original: string;
  translated: string;
  photo_query: string;
  description: string;
  ingredients: string[];
  allergens: string[];
  category: DishCategory;
  dietary: { vegetarian: boolean; vegan: boolean; gluten_free: boolean };
  spice_level: 0 | 1 | 2 | 3;
  price: string | null;
  currency: string | null;
}

export interface MenuSection {
  name: string;
  name_translated: string;
  items: MenuItem[];
}

export interface Menu {
  restaurant_name: string | null;
  restaurant_address: string | null;
  restaurant_language: string;
  cuisine: string;
  sections: MenuSection[];
}

export const MENU_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    restaurant_name: {
      type: ["string", "null"],
      description:
        "Nazwa restauracji, jeśli widoczna na którymkolwiek zdjęciu (np. okładka, nagłówek, stopka). Jeśli nie ma — null.",
    },
    restaurant_address: {
      type: ["string", "null"],
      description: "Adres lokalu, jeśli widoczny na menu. Jeśli nie ma — null.",
    },
    restaurant_language: {
      type: "string",
      description: "Wykryty język menu jako kod ISO 639-1, np. 'it', 'fr', 'pl'.",
    },
    cuisine: {
      type: "string",
      description:
        "Rodzaj kuchni ustalony z menu (np. 'kuchnia indyjska', 'kuchnia hiszpańska', 'włoska'). Gdy nieoczywiste — 'nieokreślona'.",
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Oryginalna nazwa sekcji." },
          name_translated: { type: "string", description: "Nazwa sekcji po przetłumaczeniu." },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                original: { type: "string", description: "Nazwa dania w oryginale." },
                translated: { type: "string", description: "Nazwa dania po przetłumaczeniu." },
                photo_query: {
                  type: "string",
                  description:
                    "Krótka, GENERYCZNA nazwa dania PO ANGIELSKU do wyszukania zdjęcia w internecie — opisz, CZYM danie jest (typ potrawy), a NIE markową/lokalną nazwą z menu. Przykłady: 'Nordic Taste' → 'smoked salmon avocado toast'; 'Cúrcuma Platter' → 'indian mixed appetizer platter'; 'Patates Braves' → 'patatas bravas'; 'Double Smash BBQ' → 'bbq smash burger'. Dla zwykłych, jednoznacznych nazw może to być po prostu ta nazwa po angielsku.",
                },
                description: {
                  type: "string",
                  description:
                    "Zwięzłe wyjaśnienie czym jest danie: typowe składniki, sposób podania, kontekst kulinarny.",
                },
                ingredients: {
                  type: "array",
                  items: { type: "string" },
                  description: "Typowe składniki dania (przetłumaczone).",
                },
                allergens: {
                  type: "array",
                  items: { type: "string" },
                  description: "Prawdopodobne alergeny (gluten, orzechy, ryby, jaja, laktoza itd.).",
                },
                category: { type: "string", enum: [...DISH_CATEGORIES] },
                dietary: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    vegetarian: { type: "boolean" },
                    vegan: { type: "boolean" },
                    gluten_free: { type: "boolean" },
                  },
                  required: ["vegetarian", "vegan", "gluten_free"],
                },
                spice_level: {
                  type: "integer",
                  enum: [0, 1, 2, 3],
                  description: "Poziom ostrości: 0 = brak, 3 = bardzo ostre.",
                },
                price: { type: ["string", "null"], description: "Cena jako tekst, lub null." },
                currency: { type: ["string", "null"], description: "Waluta, np. 'EUR', lub null." },
              },
              required: [
                "original",
                "translated",
                "photo_query",
                "description",
                "ingredients",
                "allergens",
                "category",
                "dietary",
                "spice_level",
                "price",
                "currency",
              ],
            },
          },
        },
        required: ["name", "name_translated", "items"],
      },
    },
  },
  required: [
    "restaurant_name",
    "restaurant_address",
    "restaurant_language",
    "cuisine",
    "sections",
  ],
} as const;
