// Rozszerzony, tekstowy opis pojedynczego dania ("więcej info").
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, isModelId, type ModelId } from "./menu.ts";
import { usesOpenAiApi, isOpenAiReasoning, apiTag } from "./models.ts";
import { getClientForModel } from "./openaiClient.ts";
import { usageFrom, usageFromOpenAI, logUsage, ZERO_USAGE, type Usage } from "./usage.ts";
import { track, recordUsage } from "./apiLog.ts";
import { cacheGet, cacheSet, cacheKey } from "./cache.ts";

const client = new Anthropic({ maxRetries: 4 });

export interface DishInfoInput {
  name: string;
  description?: string;
  restaurant?: string;
  cuisine?: string;
  location?: string; // kraj/miasto, np. "Badalona, Hiszpania"
  targetLang: string;
  model?: ModelId;
  /** Pomiń cache (LAB / porównania modeli). */
  noCache?: boolean;
}

export const SYSTEM = [
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
): Promise<{ text: string; usage: Usage; cached?: boolean }> {
  const model: ModelId = isModelId(input.model) ? input.model : DEFAULT_MODEL;

  // ② CACHE opisu — opis jest „jak podaje się to w TEJ kuchni i regionie", więc niezależny od
  // konkretnego lokalu. Klucz: danie + KRÓTKI OPIS (wariant, np. „tost z awokado") + kuchnia + KRAJ +
  // język + model. Opis JEST w kluczu, więc cache'ujemy ZAWSZE bezstratnie (różny opis → różny wpis), a
  // re-skan tego samego menu (ten sam opis) TRAFIA w cache. Wcześniej przy każdym opisie z menu pomijaliśmy
  // cache → opisy liczyły się od zera co skan (największy powtarzalny koszt).
  const country = input.location ? input.location.split(",").pop()?.trim() || input.location : undefined;
  const useCache = !input.noCache;
  const ck = cacheKey("dish-info", input.name, input.description ?? "", input.cuisine, country, input.targetLang, model);
  if (useCache) {
    const hit = await cacheGet<string>("dish-info", ck, { op: "dish-info" });
    if (hit) return { text: hit, usage: ZERO_USAGE, cached: true };
  }

  // Treść zapytania (ta sama dla obu providerów).
  const userText =
    `Danie: ${input.name}\n` +
    (input.description ? `Krótki opis z menu: ${input.description}\n` : "") +
    (input.cuisine ? `Rodzaj kuchni: ${input.cuisine}\n` : "") +
    (input.location ? `Lokalizacja lokalu: ${input.location}\n` : "") +
    (input.restaurant ? `Restauracja: ${input.restaurant}\n` : "") +
    `Język odpowiedzi: ${input.targetLang}\n\n` +
    "Rozwiń informacje o tym daniu, trzymając się powyższego kontekstu.";

  if (usesOpenAiApi(model)) {
    const openai = getClientForModel(model);
    const tag = apiTag(model); // "openai" albo "google"
    const params: import("openai").OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model,
      // GPT-5 to model ROZUMUJĄCY: max_completion_tokens obejmuje też tokeny rozumowania.
      // Przy 1500 całość szła na rozumowanie → finish=length i PUSTA treść. Prosty opis nie
      // wymaga rozumowania, więc minimalizujemy je i dajemy zapas na samą odpowiedź.
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userText },
      ],
    };
    if (isOpenAiReasoning(model)) params.reasoning_effort = "minimal"; // Gemini bez tego pola
    const resp = await track(tag, "dish-info", () => openai.chat.completions.create(params));
    const out = resp.choices[0]?.message?.content;
    if (!out) throw new Error(`Brak odpowiedzi modelu (${tag}, finish=${resp.choices[0]?.finish_reason ?? "?"}).`);
    const usage = usageFromOpenAI(model, resp.usage);
    recordUsage(tag, usage.inputTokens, usage.outputTokens, usage.costUsd, model);
    logUsage(`dish-info (${tag})`, model, usage);
    if (useCache) void cacheSet("dish-info", ck, out, { lang: input.targetLang });
    return { text: out, usage };
  }

  const response = await track("claude", "dish-info", () =>
    client.messages.create({
      model,
      max_tokens: 1500,
      // ⑤ Prompt caching: długi SYSTEM cache’owany po stronie Anthropic (~90% taniej input przy
      // powtórkach w 5 min). usage.ts już czyta cache_read/creation tokeny.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
    }),
  );

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error(`Brak odpowiedzi (stop_reason=${response.stop_reason}).`);
  }
  const usage = usageFrom(model, response.usage);
  recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
  logUsage("dish-info", model, usage);
  if (useCache) void cacheSet("dish-info", ck, text.text, { lang: input.targetLang });
  return { text: text.text, usage };
}
