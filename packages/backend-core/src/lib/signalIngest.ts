// Single source of truth for persisting a detected Signal + its EvidenceSource.
//
// Before this, three paths created signals independently: the manual /api/signals
// route (which attached evidence), and the discovery + Apollo-enrichment paths
// (which did NOT) — so automated signals had no provenance/freshness, undercutting
// the evidence-first promise. Everything now flows through ingestSignal().
//
// Lives in backend-core so workers, the shared enrich core, and route handlers can
// share it without a circular dependency. Does NOT rescore — callers rescore once
// per batch.
import { prisma } from './prisma.js'
import type { SignalType } from './signalEngine.js'

// Deterministic idempotency key: the same source+type+title within a month
// upserts instead of duplicating. (Relocated here from the prospects route.)
export function buildSignalFingerprint(source: string, type: string, title: string | null, date: Date): string {
  const slug = (title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
  const month = date.toISOString().slice(0, 7)
  return `${source}:${type}:${slug}:${month}`
}

export type SignalEvidenceInput = {
  provider: string
  sourceType: string
  sourceUrl?: string | null
  observedAt?: Date
  expiresAt?: Date | null
  confidence?: number
  rawText?: string | null
}

export type IngestSignalInput = {
  workspaceId: string
  prospectId: string
  type: SignalType
  strength: number
  source: string
  title?: string | null
  description?: string | null
  sourceUrl?: string | null
  sourceReliability?: number
  industryRelevance?: number
  detectedAt?: Date
  evidence?: SignalEvidenceInput
}

/**
 * Idempotently upsert a Signal (by prospect+fingerprint) and, when `evidence` is
 * supplied, create an EvidenceSource and link it so the signal can answer "where
 * did this come from / how fresh is it?". Returns the upserted Signal row.
 */
export async function ingestSignal(input: IngestSignalInput) {
  const detectedAt = input.detectedAt ?? new Date()
  const fp = buildSignalFingerprint(input.source, input.type, input.title ?? null, detectedAt)

  let evidenceSourceId: string | null = null
  if (input.evidence) {
    const conf = Number(input.evidence.confidence)
    const ev = await prisma.evidenceSource.create({
      data: {
        workspaceId: input.workspaceId,
        prospectId: input.prospectId,
        provider: input.evidence.provider,
        sourceType: input.evidence.sourceType,
        sourceUrl: input.evidence.sourceUrl ?? input.sourceUrl ?? null,
        observedAt: input.evidence.observedAt ?? detectedAt,
        expiresAt: input.evidence.expiresAt ?? null,
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
        rawText: input.evidence.rawText ?? null,
      },
      select: { id: true },
    })
    evidenceSourceId = ev.id
  }

  return prisma.signal.upsert({
    where: { prospectId_fingerprint: { prospectId: input.prospectId, fingerprint: fp } },
    create: {
      workspaceId: input.workspaceId,
      prospectId: input.prospectId,
      evidenceSourceId,
      type: input.type,
      strength: input.strength,
      sourceReliability: input.sourceReliability ?? 70,
      industryRelevance: input.industryRelevance ?? 50,
      title: input.title ?? null,
      description: input.description ?? null,
      sourceUrl: input.sourceUrl ?? null,
      source: input.source,
      fingerprint: fp,
      detectedAt,
    },
    update: {
      strength: input.strength,
      detectedAt,
      ...(evidenceSourceId ? { evidenceSourceId } : {}),
    },
  })
}
