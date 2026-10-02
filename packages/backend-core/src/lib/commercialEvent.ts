import type { SignalType } from '@acaos/shared'
import type { RawSignal } from './signalEngine.js'

export type CommercialEventType =
  | 'ACTIVE_PROCUREMENT'
  | 'CAPACITY_EXPANSION'
  | 'GROWTH_EVENT'
  | 'ORGANISATIONAL_CHANGE'
  | 'DIGITAL_CHANGE'
  | 'MARKET_ATTENTION'
  | 'EARLY_BUYING_TRIGGER'
  | 'NO_CLEAR_EVENT'

export type CommercialEvent = {
  type: CommercialEventType
  confidence: number
  title: string
  whyNow: string
  supportingTypes: SignalType[]
}

const RECENT_DAYS = 30

function recent(s: RawSignal, now: number): boolean {
  return (now - s.detectedAt.getTime()) / 86_400_000 <= RECENT_DAYS
}

function has(types: Set<SignalType>, ...wanted: SignalType[]): boolean {
  return wanted.every(t => types.has(t))
}

/**
 * Converts raw signals into one conservative commercial hypothesis. This is
 * deliberately deterministic: the classifier must be explainable and must not
 * invent a buying event that the evidence does not support.
 */
export function inferCommercialEvent(signals: RawSignal[], now = Date.now()): CommercialEvent {
  const usable = signals.filter(s => recent(s, now) && s.sourceReliability >= 40 && s.industryRelevance >= 40)
  const types = new Set(usable.map(s => s.type))
  const supportingTypes = [...types]

  if (has(types, 'PROCUREMENT')) {
    return {
      type: 'ACTIVE_PROCUREMENT', confidence: Math.min(96, 72 + supportingTypes.length * 5),
      title: 'Active procurement', whyNow: 'Procurement activity is a direct indicator of an active buying process.', supportingTypes,
    }
  }
  if (has(types, 'EXPANSION', 'HIRING') || has(types, 'FUNDING', 'HIRING', 'EXPANSION')) {
    return {
      type: 'CAPACITY_EXPANSION', confidence: Math.min(94, 70 + supportingTypes.length * 6),
      title: 'Capacity expansion', whyNow: 'Expansion and workforce growth together indicate increasing operational demand.', supportingTypes,
    }
  }
  if (has(types, 'FUNDING', 'HIRING') || has(types, 'FUNDING', 'EXPANSION')) {
    return {
      type: 'GROWTH_EVENT', confidence: Math.min(92, 68 + supportingTypes.length * 6),
      title: 'Growth event', whyNow: 'Capital and operating-growth signals point to increased spending capacity or demand.', supportingTypes,
    }
  }
  if (has(types, 'LEADERSHIP_CHANGE', 'FUNDING') || has(types, 'LEADERSHIP_CHANGE', 'EXPANSION')) {
    return {
      type: 'ORGANISATIONAL_CHANGE', confidence: Math.min(88, 64 + supportingTypes.length * 6),
      title: 'Organisational change', whyNow: 'Leadership change combined with business change can reset priorities and suppliers.', supportingTypes,
    }
  }
  if (has(types, 'TECH_ADOPTION', 'WEBSITE_CHANGE')) {
    return {
      type: 'DIGITAL_CHANGE', confidence: Math.min(82, 60 + supportingTypes.length * 5),
      title: 'Digital change', whyNow: 'Technology and website changes indicate an active change programme.', supportingTypes,
    }
  }
  if (has(types, 'NEWS_MENTION', 'BUSINESS_REGISTRATION') || has(types, 'NEWS_MENTION', 'EXPANSION')) {
    return {
      type: 'MARKET_ATTENTION', confidence: Math.min(78, 56 + supportingTypes.length * 5),
      title: 'Market activity', whyNow: 'Independent public signals indicate recent business activity worth monitoring.', supportingTypes,
    }
  }
  if (supportingTypes.length > 0) {
    return {
      type: 'EARLY_BUYING_TRIGGER', confidence: Math.min(68, 45 + supportingTypes.length * 7),
      title: 'Early buying trigger', whyNow: 'Recent activity is relevant but does not yet prove a specific commercial event.', supportingTypes,
    }
  }
  return { type: 'NO_CLEAR_EVENT', confidence: 0, title: 'No clear commercial event', whyNow: 'Current evidence does not support a specific buying hypothesis.', supportingTypes: [] }
}
