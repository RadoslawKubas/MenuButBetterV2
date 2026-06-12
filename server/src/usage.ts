// Licznik zużycia tokenów i kosztu wywołań modeli (wariant „licznik kosztów").
// Cennik $ / 1M tokenów — z oficjalnej tabeli Anthropic.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** Buduje Usage (tokeny + koszt $) z surowego `response.usage` dla danego modelu. */
export function usageFrom(model: string, raw: RawUsage): Usage {
  const price = PRICING[model] ?? { in: 0, out: 0 };
  const inputTokens =
    (raw.input_tokens ?? 0) +
    (raw.cache_creation_input_tokens ?? 0) +
    (raw.cache_read_input_tokens ?? 0);
  const outputTokens = raw.output_tokens ?? 0;
  const costUsd = (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
  return { inputTokens, outputTokens, costUsd };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Log diagnostyczny do konsoli serwera. */
export function logUsage(tag: string, model: string, usage: Usage): void {
  console.log(
    `[${tag}] model=${model} in=${usage.inputTokens} out=${usage.outputTokens} ` +
      `$${usage.costUsd.toFixed(4)}`,
  );
}
