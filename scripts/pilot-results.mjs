/**
 * Pilot results reader — answers the only question the pilot exists to answer:
 * "which signals actually drive replies?"
 *
 * It reads OutreachSent rows (each stamped at send time with the evidence
 * snapshot that justified it — see Stage 5 provenance) and correlates the
 * signal types behind each send with whether it got a reply. That's the
 * signal-to-reply loop, measured.
 *
 * Usage:
 *   DATABASE_URL=postgres://...  WORKSPACE_ID=ws_xxx  node scripts/pilot-results.mjs
 *
 * Reads only. Writes nothing. Safe to run against production.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({ log: ['error'] })

// Keep in sync with apps/api/src/lib/learningLoop.ts — the scorer ignores
// calibration until it has this many real outcomes.
const MIN_OUTCOMES = 10

function pct(n, d) {
  if (!d) return '—'
  return `${((n / d) * 100).toFixed(0)}%`
}

async function main() {
  const workspaceId = process.env.WORKSPACE_ID?.trim()
  if (!workspaceId) {
    console.error('Set WORKSPACE_ID (and DATABASE_URL). Aborting.')
    process.exit(1)
  }

  const sends = await prisma.outreachSent.findMany({
    where: { workspaceId },
    select: {
      id: true, toEmail: true, subject: true, sentAt: true,
      repliedAt: true, replyIntent: true, status: true,
      evidenceSnapshot: true, outreachIntentId: true,
    },
    orderBy: { sentAt: 'desc' },
  })

  const total = sends.length
  const replied = sends.filter((s) => s.repliedAt).length

  console.log('\n══════════════════════════════════════════════════')
  console.log(`  ACAOS pilot results — workspace ${workspaceId}`)
  console.log('══════════════════════════════════════════════════')
  console.log(`  Sent:           ${total}`)
  console.log(`  Replied:        ${replied}  (${pct(replied, total)} reply rate)`)
  console.log(`  Evidence-backed sends: ${sends.filter((s) => s.outreachIntentId).length}`)
  console.log('')

  // The core readout: reply rate per signal type. A signal type appears once
  // per send if it was in that send's evidence snapshot.
  const byType = new Map() // type -> { sends, replies }
  for (const s of sends) {
    const snap = s.evidenceSnapshot
    const signals = (snap && typeof snap === 'object' && Array.isArray(snap.signals)) ? snap.signals : []
    const types = new Set(signals.map((x) => x?.type).filter(Boolean))
    for (const t of types) {
      const row = byType.get(t) ?? { sends: 0, replies: 0 }
      row.sends++
      if (s.repliedAt) row.replies++
      byType.set(t, row)
    }
  }

  if (byType.size) {
    console.log('  Reply rate by signal type (the moat question):')
    const ranked = [...byType.entries()].sort((a, b) => {
      const ra = a[1].replies / a[1].sends, rb = b[1].replies / b[1].sends
      return rb - ra
    })
    for (const [type, r] of ranked) {
      console.log(`    ${type.padEnd(22)} ${String(r.replies).padStart(2)}/${String(r.sends).padEnd(3)}  ${pct(r.replies, r.sends)}`)
    }
    console.log('')
  } else {
    console.log('  No evidence-backed sends yet — feed signals + send to populate this.\n')
  }

  // Reply intents (positive vs not) so you can read quality, not just volume.
  const intents = new Map()
  for (const s of sends.filter((x) => x.repliedAt)) {
    const k = s.replyIntent ?? 'UNCLASSIFIED'
    intents.set(k, (intents.get(k) ?? 0) + 1)
  }
  if (intents.size) {
    console.log('  Reply intents:')
    for (const [k, n] of [...intents.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(k).padEnd(22)} ${n}`)
    }
    console.log('')
  }

  // Learning-loop readiness: the scorer self-calibrates only past MIN_OUTCOMES.
  const outcomes = await prisma.scoringOutcome.count({ where: { workspaceId } })
  console.log(`  Learning-loop outcomes recorded: ${outcomes} / ${MIN_OUTCOMES} needed`)
  console.log(outcomes >= MIN_OUTCOMES
    ? '    ✓ Enough outcomes — the scorer can start calibrating on real results.'
    : `    … ${MIN_OUTCOMES - outcomes} more outcomes until calibration kicks in.`)
  console.log('')

  // Recent replies, so you can eyeball the actual wins.
  const recentReplies = sends.filter((s) => s.repliedAt).slice(0, 10)
  if (recentReplies.length) {
    console.log('  Recent replies:')
    for (const s of recentReplies) {
      console.log(`    ${s.repliedAt.toISOString().slice(0, 10)}  ${s.toEmail.padEnd(32)} [${s.replyIntent ?? '—'}]  ${s.subject.slice(0, 40)}`)
    }
    console.log('')
  }

  console.log('  Decision rule: automate the signal source feeding the top')
  console.log('  reply-rate signal type above. Ignore the long tail for now.')
  console.log('══════════════════════════════════════════════════\n')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
