// Learning adaptation mode — the single switch deciding whether the learning
// loops may change production behaviour.
//
//   off      compute nothing; scoring stays exactly as configured
//   shadow   compute proposals and store them; apply nothing (DEFAULT)
//   approved compute proposals as recommendations awaiting human approval
//   live     apply learned *scoring* adjustments automatically
//
// Hard rule regardless of mode: learning never rewrites a workspace's ICP.
// ICP changes are always stored as LearningRecommendations for a human.
export type LearningAdaptationMode = 'off' | 'shadow' | 'approved' | 'live'

const MODES: readonly LearningAdaptationMode[] = ['off', 'shadow', 'approved', 'live']

export function learningAdaptationMode(): LearningAdaptationMode {
  const v = (process.env.LEARNING_ADAPTATION_MODE ?? '').trim().toLowerCase()
  return (MODES as readonly string[]).includes(v) ? (v as LearningAdaptationMode) : 'shadow'
}

/** Minimum outcomes before a per-feature weight may move at all. */
export const MIN_FEATURE_SAMPLES = 30
/** Maximum relative change to any one weight per learning iteration (±10%). */
export const MAX_WEIGHT_STEP = 0.1

/** Population variance; features with ~0 variance carry no information. */
export function variance(xs: number[]): number {
  if (xs.length === 0) return 0
  const m = xs.reduce((s, x) => s + x, 0) / xs.length
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length
}

/**
 * Whether a feature is eligible to acquire learned weight: enough samples and
 * real variance. A constant feature (e.g. a 0.5 placeholder) can never
 * discriminate between outcomes, so it must never gain weight.
 */
export function isLearnableFeature(values: number[], minSamples = MIN_FEATURE_SAMPLES): boolean {
  return values.length >= minSamples && variance(values) > 1e-6
}
