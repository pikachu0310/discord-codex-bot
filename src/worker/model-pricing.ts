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

const RATES: Readonly<Record<string, ModelPricingRate>> = {
  "gpt-5.2": {
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.175,
    outputUsdPerMillion: 14,
  },
  "gpt-5.1": {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
  },
  "gpt-5": {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
  },
  "gpt-5-mini": {
    inputUsdPerMillion: 0.25,
    cachedInputUsdPerMillion: 0.025,
    outputUsdPerMillion: 2,
  },
  "gpt-5-nano": {
    inputUsdPerMillion: 0.05,
    cachedInputUsdPerMillion: 0.005,
    outputUsdPerMillion: 0.4,
  },
  "gpt-5.2-chat-latest": {
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.175,
    outputUsdPerMillion: 14,
  },
  "gpt-5.1-chat-latest": {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
  },
  "gpt-5-chat-latest": {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
  },
  "gpt-5.2-codex": {
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.175,
    outputUsdPerMillion: 14,
  },
  "gpt-5.1-codex-max": {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
  },
  "gpt-5.1-codex": {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
  },
  "gpt-5-codex": {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
  },
  "gpt-5.2-pro": { inputUsdPerMillion: 21, outputUsdPerMillion: 168 },
  "gpt-5-pro": { inputUsdPerMillion: 15, outputUsdPerMillion: 120 },
  "gpt-4.1": {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 8,
  },
  "gpt-4.1-mini": {
    inputUsdPerMillion: 0.4,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 1.6,
  },
  "gpt-4.1-nano": {
    inputUsdPerMillion: 0.1,
    cachedInputUsdPerMillion: 0.025,
    outputUsdPerMillion: 0.4,
  },
  "gpt-4o": {
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10,
  },
  "gpt-4o-mini": {
    inputUsdPerMillion: 0.15,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 0.6,
  },
  "codex-mini-latest": {
    inputUsdPerMillion: 1.5,
    cachedInputUsdPerMillion: 0.15,
    outputUsdPerMillion: 6,
  },
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
