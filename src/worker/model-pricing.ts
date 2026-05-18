import type { ParsedUsage } from "./codex-stream-processor.ts";

interface ModelPricingRate {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}

interface CostEstimate {
  usd: number;
  model: string;
}

const rate = (
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
  cachedInputUsdPerMillion?: number,
): ModelPricingRate => ({
  inputUsdPerMillion,
  outputUsdPerMillion,
  ...(cachedInputUsdPerMillion !== undefined
    ? { cachedInputUsdPerMillion }
    : {}),
});

// The worker only needs the pricing columns required to estimate cost when
// OpenAI omits `cost_usd`, so we keep the model-to-rate table compact.
const RATES: Readonly<Record<string, ModelPricingRate>> = {
  "gpt-5.5": rate(5.0, 30.0, 0.5),
  "gpt-5.5-pro": rate(30.0, 180.0),
  "gpt-5.4": rate(2.5, 15.0, 0.25),
  "gpt-5.4-mini": rate(0.75, 4.5, 0.075),
  "gpt-5.4-nano": rate(0.2, 1.25, 0.02),
  "gpt-5.4-pro": rate(30.0, 180.0),
  "gpt-5.3-codex": rate(1.75, 14.0, 0.175),
  "gpt-5.2": rate(1.75, 14.0, 0.175),
  "gpt-5.2-pro": rate(21.0, 168.0),
  "gpt-5.1": rate(1.25, 10.0, 0.125),
  "gpt-5": rate(1.25, 10.0, 0.125),
  "gpt-5-mini": rate(0.25, 2.0, 0.025),
  "gpt-5-nano": rate(0.05, 0.4, 0.005),
  "gpt-5-pro": rate(15.0, 120.0),
  "gpt-4.1": rate(2.0, 8.0, 0.5),
  "gpt-4.1-mini": rate(0.4, 1.6, 0.1),
  "gpt-4.1-nano": rate(0.1, 0.4, 0.025),
  "gpt-4o": rate(2.5, 10.0, 1.25),
  "gpt-4o-mini": rate(0.15, 0.6, 0.075),
  "o4-mini": rate(1.1, 4.4, 0.275),
  "o3": rate(2.0, 8.0, 0.5),
  "o3-mini": rate(1.1, 4.4, 0.55),
  "o3-pro": rate(20.0, 80.0),
  "o1": rate(15.0, 60.0, 7.5),
  "o1-mini": rate(1.1, 4.4, 0.55),
  "o1-pro": rate(150.0, 600.0),
  "gpt-4o-2024-05-13": rate(5.0, 15.0),
  "gpt-4-turbo-2024-04-09": rate(10.0, 30.0),
  "gpt-4-0125-preview": rate(10.0, 30.0),
  "gpt-4-1106-preview": rate(10.0, 30.0),
  "gpt-4-1106-vision-preview": rate(10.0, 30.0),
  "gpt-4-0613": rate(30.0, 60.0),
  "gpt-4-0314": rate(30.0, 60.0),
  "gpt-4-32k": rate(60.0, 120.0),
  "gpt-3.5-turbo": rate(0.5, 1.5),
  "gpt-3.5-turbo-0125": rate(0.5, 1.5),
  "gpt-3.5-turbo-1106": rate(1.0, 2.0),
  "gpt-3.5-turbo-0613": rate(1.5, 2.0),
  "gpt-3.5-0301": rate(1.5, 2.0),
  "gpt-3.5-turbo-instruct": rate(1.5, 2.0),
  "gpt-3.5-turbo-16k-0613": rate(3.0, 4.0),
  "davinci-002": rate(2.0, 2.0),
  "babbage-002": rate(0.4, 0.4),
  "gpt-5.2-chat-latest": rate(1.75, 14.0, 0.175),
  "gpt-5.1-chat-latest": rate(1.25, 10.0, 0.125),
  "gpt-5-chat-latest": rate(1.25, 10.0, 0.125),
  "gpt-5.2-codex": rate(1.75, 14.0, 0.175),
  "gpt-5.1-codex-max": rate(1.25, 10.0, 0.125),
  "gpt-5.1-codex": rate(1.25, 10.0, 0.125),
  "gpt-5-codex": rate(1.25, 10.0, 0.125),
  "codex-mini-latest": rate(1.5, 6.0, 0.15),
};

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

function resolveRate(
  model?: string,
): { model: string; rate: ModelPricingRate } | null {
  if (!model) return null;
  const normalized = normalizeModel(model);

  const exact = RATES[normalized];
  if (exact) return { model: normalized, rate: exact };

  const dateSuffixMatch = normalized.match(/^(.*)-\d{4}-\d{2}-\d{2}$/);
  if (dateSuffixMatch) {
    const base = dateSuffixMatch[1];
    const baseRate = RATES[base];
    if (baseRate) return { model: base, rate: baseRate };
  }

  return null;
}

export function estimateCostUsd(usage: ParsedUsage): CostEstimate | null {
  const resolved = resolveRate(usage.model);
  if (!resolved) return null;

  const { model, rate } = resolved;
  const safeInput = Math.max(usage.inputTokens, 0);
  const safeCachedInput = Math.max(usage.cachedInputTokens, 0);
  const chargedCachedInput = Math.min(safeCachedInput, safeInput);
  const chargedInput = Math.max(safeInput - chargedCachedInput, 0);
  const safeOutput = Math.max(usage.processingTokens + usage.outputTokens, 0);
  const cachedRate = rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion;

  const usd = (
    chargedInput * rate.inputUsdPerMillion +
    chargedCachedInput * cachedRate +
    safeOutput * rate.outputUsdPerMillion
  ) / 1_000_000;

  return { usd, model };
}
