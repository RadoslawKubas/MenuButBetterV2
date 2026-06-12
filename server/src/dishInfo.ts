// Rozszerzony, tekstowy opis pojedynczego dania ("więcej info").
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, isModelId, type ModelId } from "./menu.ts";
import { usageFrom, logUsage, type Usage } from "./usage.ts";

const client = new Anthropic();

export interface DishInfoInput {
  name: string;
  description?: string;
  restaurant?: string;
  cuisine?: string;
  location?: string; // kraj/miasto, np. "Badalona, Hiszpania"
  targetLang: string;
  model?: ModelId;
}

const SYSTEM = [
  "Jesteś ekspertem kulinarnym znającym kuchnie świata i lokalne realia.",
  "Rozwiń wiedzę o KONKRETNYM daniu dla gościa danej restauracji.",
  "ZAWSZE uwzględnij podany kontekst: rodzaj kuchni oraz kraj/miasto lokalu.",
  "Opisz danie tak, jak realnie podaje się je w TEJ kuchni i w TYM regionie:",
  "pochodzenie, typowe składniki i przygotowanie, smak i teksturę, jak się je,",
  "poziom ostrości, lokalne warianty. SKUP SIĘ na tym, czego można się spodziewać",
  "w takim miejscu. Przy daniach lokalnych/regionalnych opisz więcej i ciekawiej.",
  "WAŻNE: nie zmyślaj konkretów, których nie wiesz, i nie dodawaj składników nietypowych",
  "dla tego dania w tej kuchni (np. awokado do prostej sałatki w kuchni indyjskiej).",
  "Jeśli czegoś nie jesteś pewien — pisz ogólnie zamiast wymyślać szczegóły.",
  "150–250 słów, w języku docelowym. Bez wstępów typu Oto informacje — od razu treść.",
].join(" ");

export async function describeDish(
  input: DishInfoInput,
): Promise<{ text: string; usage: Usage }> {
  const model: ModelId = isModelId(input.model) ? input.model : DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Danie: ${input.name}\n` +
          (input.description ? `Krótki opis z menu: ${input.description}\n` : "") +
          (input.cuisine ? `Rodzaj kuchni: ${input.cuisine}\n` : "") +
          (input.location ? `Lokalizacja lokalu: ${input.location}\n` : "") +
          (input.restaurant ? `Restauracja: ${input.restaurant}\n` : "") +
          `Język odpowiedzi: ${input.targetLang}\n\n` +
          "Rozwiń informacje o tym daniu, trzymając się powyższego kontekstu.",
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error(`Brak odpowiedzi (stop_reason=${response.stop_reason}).`);
  }
  const usage = usageFrom(model, response.usage);
  logUsage("dish-info", model, usage);
  return { text: text.text, usage };
}
