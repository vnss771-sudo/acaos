// OpenAI model compatibility profiles.
//
// Request construction must not infer capabilities independently in multiple
// places: that is how the GPT-5 temperature regression slipped through while the
// token/reasoning helper tests were green. Known ACAOS models live here. Custom
// allow-listed models still receive a conservative family fallback so a GPT-5 or
// o-series model cannot accidentally inherit legacy sampling/token parameters.

export type TokenParameter = 'max_completion_tokens' | 'max_tokens'
export type ModelProfile = {
  reasoning: boolean
  tokenParameter: TokenParameter
  supportsTemperature: boolean
  defaultReasoningEffort: 'low' | null
}

const STANDARD_CHAT: ModelProfile = {
  reasoning: false,
  tokenParameter: 'max_tokens',
  supportsTemperature: true,
  defaultReasoningEffort: null,
}

const REASONING: ModelProfile = {
  reasoning: true,
  tokenParameter: 'max_completion_tokens',
  supportsTemperature: false,
  defaultReasoningEffort: 'low',
}

const O_SERIES: ModelProfile = {
  reasoning: true,
  tokenParameter: 'max_completion_tokens',
  supportsTemperature: false,
  // ACAOS does not force an effort value on o-series; provider defaults apply.
  defaultReasoningEffort: null,
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'

export const MODEL_PROFILES = {
  'gpt-5-mini': REASONING,
  'gpt-5-nano': REASONING,
  'o4-mini': O_SERIES,
  'gpt-4o-mini': STANDARD_CHAT,
  'gpt-4o': STANDARD_CHAT,
  'gpt-4.1': STANDARD_CHAT,
  'gpt-4.1-mini': STANDARD_CHAT,
  'gpt-4.1-nano': STANDARD_CHAT,
} as const satisfies Record<string, ModelProfile>

export const BUILTIN_OPENAI_MODELS = Object.freeze(Object.keys(MODEL_PROFILES))

export function modelProfile(modelName: string): ModelProfile {
  const known = MODEL_PROFILES[modelName as keyof typeof MODEL_PROFILES]
  if (known) return known

  // Safe compatibility fallback for operator-supplied allow-listed variants.
  if (/^gpt-5(?:[.-]|$)/i.test(modelName)) return REASONING
  if (/^o\d+(?:-|$)/i.test(modelName)) return O_SERIES
  return STANDARD_CHAT
}
