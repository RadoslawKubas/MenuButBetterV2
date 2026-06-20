// „Szybki podgląd" — lekka ocena POJEDYNCZEGO zdjęcia na żywo z aparatu: czy to menu,
// rodzaj kuchni, nazwa lokalu (z szyldu/nagłówka). BEZ dokładnej analizy dań — ma być
// szybko i tanio (tani model konfigurowany osobno). Błąd → pusty wynik (nie blokuje).
import Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { usageFrom, ZERO_USAGE, type Usage } from "./usage.ts";
import { track, recordUsage, recordBytes } from "./apiLog.ts";
import { openaiVisionJson } from "./openaiClient.ts";
import { usesOpenAiApi, apiTag } from "./models.ts";

const client = new Anthropic({ maxRetries: 4 });

export interface PeekResult {
  isMenu: boolean;
  cuisine: string;
  restaurantName: string;
  /** Czy ze zdjęcia da się COKOLWIEK sensownie odczytać (ostre/czytelne). false = za słaba jakość. */
  readable: boolean;
}

type ImgMedia = "image/jpeg" | "image/png" | "image/webp";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_menu: { type: "boolean", description: "Czy zdjęcie przedstawia menu / kartę dań." },
    cuisine: { type: "string", description: "Rodzaj kuchni (np. włoska, indyjska) albo '' gdy nieznana." },
    restaurant_name: { type: "string", description: "Nazwa lokalu jeśli widoczna (szyld/nagłówek/stopka), albo ''." },
    readable: { type: "boolean", description: "Czy zdjęcie jest dość OSTRE i CZYTELNE, by odczytać z niego tekst/treść. false = rozmazane, za ciemne, prześwietlone, ucięte albo przypadkowe (nic sensownego do odczytania)." },
  },
  required: ["is_menu", "cuisine", "restaurant_name", "readable"],
} as const;

export const SYSTEM =
  "Rzucasz OKIEM na zdjęcie i szybko oceniasz kontekst — bez dokładnej analizy dań. " +
  "Podaj: czy to menu/karta dań, rodzaj kuchni oraz nazwę lokalu, jeśli widać ją na szyldzie, " +
  "nagłówku lub w stopce. Jeśli czegoś nie wiesz, zostaw puste ('').";

export const INSTRUCTION =
  "Oceń to zdjęcie: is_menu (czy to menu), cuisine (rodzaj kuchni), restaurant_name (nazwa lokalu, jeśli widoczna) " +
  "oraz readable (czy zdjęcie jest dość ostre i czytelne, by cokolwiek z niego odczytać — false dla rozmazanych, " +
  "za ciemnych, prześwietlonych, uciętych albo przypadkowych zdjęć bez sensownej treści).";

function parse(json: string | null): PeekResult {
  try {
    const p = JSON.parse(json ?? "") as { is_menu?: boolean; cuisine?: string; restaurant_name?: string; readable?: boolean };
    return {
      isMenu: !!p.is_menu,
      cuisine: (p.cuisine ?? "").trim(),
      restaurantName: (p.restaurant_name ?? "").trim(),
      readable: p.readable !== false, // brak pola → traktuj jako czytelne (nie blokuj bez sygnału)
    };
  } catch {
    return { isMenu: false, cuisine: "", restaurantName: "", readable: true };
  }
}

export async function quickPeek(
  image: { base64: string; mediaType: string },
  model: string,
): Promise<{ result: PeekResult; usage: Usage }> {
  const media = (["image/jpeg", "image/png", "image/webp"].includes(image.mediaType)
    ? image.mediaType
    : "image/jpeg") as ImgMedia;
  recordBytes(apiTag(model), image.base64.length, 0); // relay zdjęcia podglądu do AI
  try {
    if (usesOpenAiApi(model)) {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        { type: "text", text: INSTRUCTION },
        { type: "image_url", image_url: { url: `data:${media};base64,${image.base64}` } },
      ];
      const { json, usage } = await openaiVisionJson({
        op: "quick-peek",
        model,
        system: SYSTEM,
        content,
        schemaName: "peek",
        schema: SCHEMA as unknown as Record<string, unknown>,
        maxCompletionTokens: 500,
      });
      return { result: parse(json), usage };
    }

    const resp = await track("claude", "quick-peek", () =>
      client.messages.create({
        model,
        max_tokens: 300,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: INSTRUCTION },
              { type: "image", source: { type: "base64", media_type: media, data: image.base64 } },
            ],
          },
        ],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    );
    const usage = usageFrom(model, resp.usage);
    recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
    const text = resp.content.find((b) => b.type === "text");
    return { result: parse(text && text.type === "text" ? text.text : null), usage };
  } catch {
    return { result: { isMenu: false, cuisine: "", restaurantName: "", readable: true }, usage: ZERO_USAGE };
  }
}
