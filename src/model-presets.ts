export const MODEL_PRESETS = {
  "sol-medium": {
    label: "GPT-6.2 Sol / Medium",
    model: "gpt-6.2-sol",
    effort: "medium",
  },
  "sol-xhigh": {
    label: "GPT-6.2 Sol / Extra High",
    model: "gpt-6.2-sol",
    effort: "xhigh",
  },
  "astra-medium": {
    label: "GPT-6.2 Astra / Medium",
    model: "gpt-6.2-astra",
    effort: "medium",
  },
  "astra-xhigh": {
    label: "GPT-6.2 Astra / Extra High",
    model: "gpt-6.2-astra",
    effort: "xhigh",
  },
} as const;

export type ModelPresetId = keyof typeof MODEL_PRESETS;
export const DEFAULT_MODEL_PRESET: ModelPresetId = "sol-xhigh";

export function isModelPreset(value: unknown): value is ModelPresetId {
  return typeof value === "string" && Object.hasOwn(MODEL_PRESETS, value);
}
