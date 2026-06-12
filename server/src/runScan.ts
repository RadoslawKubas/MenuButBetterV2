// CLI PoC: odczyt menu z jednego lub WIELU zdjęć + (opcjonalnie) zdjęcia dań.
//
// Użycie:
//   npm run scan -- <zdjęcie> [<zdjęcie2> ...] [--lang polski] [--hint "Trattoria Roma"] [--photos]
//
// Wymaga ANTHROPIC_API_KEY w .env. Zdjęcia dań (--photos) wymagają GOOGLE_CSE_KEY/CX.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { extractMenu, isModelId, type InputImage, type MediaType } from "./menu.ts";
import { dishPhotoProviderFromEnv } from "./dishPhotos.ts";

interface Args {
  imagePaths: string[];
  lang: string;
  hint?: string;
  photos: boolean;
  model?: string;
}

const MEDIA: Record<string, MediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let lang = "polski";
  let hint: string | undefined;
  let photos = false;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lang") lang = argv[++i] ?? lang;
    else if (a === "--hint") hint = argv[++i];
    else if (a === "--photos") photos = true;
    else if (a === "--model") model = argv[++i];
    else if (a && !a.startsWith("--")) positional.push(a);
  }

  if (positional.length === 0) {
    console.error(
      'Użycie: npm run scan -- <zdjęcie> [...] [--lang polski] [--hint "Nazwa"] [--model claude-opus-4-8] [--photos]',
    );
    process.exit(1);
  }
  return { imagePaths: positional, lang, hint, photos, model };
}

async function loadImage(path: string): Promise<InputImage> {
  const mediaType = MEDIA[extname(path).toLowerCase()];
  if (!mediaType) throw new Error(`Nieobsługiwany format: ${path} (użyj jpg/png/webp)`);
  return { base64: (await readFile(path)).toString("base64"), mediaType };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Brak ANTHROPIC_API_KEY — skopiuj .env.example do .env i uzupełnij klucz.");
    process.exit(1);
  }

  console.error(`📷 Czytam menu z ${args.imagePaths.length} zdjęć (→ ${args.lang})…`);
  const images = await Promise.all(args.imagePaths.map(loadImage));
  const started = Date.now();
  const { menu } = await extractMenu(images, {
    targetLang: args.lang,
    restaurantHint: args.hint,
    model: isModelId(args.model) ? args.model : undefined,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const itemCount = menu.sections.reduce((n, s) => n + s.items.length, 0);
  console.error(
    `✅ Gotowe w ${secs}s — ${menu.restaurant_name ?? "(nazwa nieznana)"}, ` +
      `język menu: ${menu.restaurant_language}, ${menu.sections.length} sekcji, ${itemCount} pozycji.\n`,
  );
  if (menu.restaurant_address) console.error(`   Adres: ${menu.restaurant_address}\n`);

  const provider = args.photos ? dishPhotoProviderFromEnv() : null;
  if (args.photos && !provider) {
    console.error("⚠️  --photos pominięte: brak GOOGLE_CSE_KEY/GOOGLE_CSE_CX w .env.\n");
  }
  const hintForPhotos = args.hint ?? menu.restaurant_name ?? undefined;

  for (const section of menu.sections) {
    console.log(`\n## ${section.name_translated}  (${section.name})`);
    for (const item of section.items) {
      const price = item.price ? `  — ${item.price}${item.currency ? " " + item.currency : ""}` : "";
      const flags = [
        item.dietary.vegan ? "🌱wega" : item.dietary.vegetarian ? "🥕wege" : "",
        item.dietary.gluten_free ? "🚫gluten" : "",
        item.spice_level > 0 ? "🌶️".repeat(item.spice_level) : "",
      ]
        .filter(Boolean)
        .join(" ");

      console.log(`\n• ${item.translated}  (${item.original})${price}  ${flags}`);
      console.log(`  ${item.description}`);
      if (item.allergens.length) console.log(`  Alergeny: ${item.allergens.join(", ")}`);

      if (provider) {
        try {
          const pics = await provider.find(item.original, hintForPhotos);
          if (pics[0]) console.log(`  📸 ${pics[0].url}  (${pics.length} kandydatów)`);
        } catch (e) {
          console.log(`  📸 (błąd wyszukiwania zdjęć: ${(e as Error).message})`);
        }
      }
    }
  }

  console.error("\n— pełny JSON poniżej —");
  console.log("\n" + JSON.stringify(menu, null, 2));
}

main().catch((e) => {
  console.error("❌ Błąd:", e instanceof Error ? e.message : e);
  process.exit(1);
});
