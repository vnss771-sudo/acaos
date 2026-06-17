/**
 * Outreach quality eval — a runnable gate for the core product output.
 *
 * Generates real outreach for representative prospects and asserts the quality
 * bar we hold the product to: correct industry inference (no ICP leak), no vague
 * filler, opens with a real personal hook when one exists (and never fabricates
 * one when it doesn't), a single clear question CTA, and a tight body.
 *
 * Usage:  OPENAI_API_KEY=sk-... npm run eval:outreach
 * Without a key it skips (exit 0) so it never blocks CI; run it locally or in a
 * keyed CI job to catch regressions in what customers actually receive.
 */
import { generateOutreach, type OutreachInput } from '../apps/api/src/services/openai.js'

type Case = {
  name: string
  input: OutreachInput
  // Tokens that prove the email understood the prospect's real trade.
  expectIndustryAnyOf: string[]
}

// A plumbing prospect under a manufacturing-heavy ICP is the exact shape that
// once produced "scaling rapidly in the manufacturing sector".
const MANUFACTURING_ICP = {
  targetIndustries: ['Manufacturing', 'Mining', 'Construction'],
  businessType: 'field operations software',
  outreachTone: 'direct',
}

const CASES: Case[] = [
  {
    name: 'Plumbing + real BNI hook (under manufacturing ICP)',
    input: {
      businessName: 'Acme Plumbing Brisbane',
      notes: 'Met at BNI last week',
      aiSummary: 'Growing plumbing service in Brisbane; coordinating job scheduling across multiple crews as they expand.',
      outreachAngle: 'Managing job dispatch across crews without a shared schedule',
      icp: MANUFACTURING_ICP,
    },
    expectIndustryAnyOf: ['plumb'],
  },
  {
    name: 'Electrical, cold (no hook)',
    input: {
      businessName: 'Smith Electrical',
      icp: MANUFACTURING_ICP,
    },
    expectIndustryAnyOf: ['electric'],
  },
  {
    name: 'HVAC + informal hook',
    input: {
      businessName: 'Coastal HVAC Services',
      notes: 'Saw your vans around the Gold Coast',
      icp: MANUFACTURING_ICP,
    },
    expectIndustryAnyOf: ['hvac', 'air', 'heating', 'cooling'],
  },
]

const BANNED_FILLER = [
  'streamline operations',
  'improve efficiency',
  'leverage',
  'synergy',
  'drive growth',
  'optimi', // optimise/optimize
  'cutting-edge',
  'best-in-class',
]

type Finding = { case: string; severity: 'FAIL' | 'WARN'; message: string }

function evaluate(c: Case, raw: string): Finding[] {
  const findings: Finding[] = []
  let parsed: { subject?: string; email?: string; followup?: string }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [{ case: c.name, severity: 'FAIL', message: 'output was not valid JSON' }]
  }
  const email = (parsed.email ?? '').trim()
  const subject = (parsed.subject ?? '').trim()
  const blob = `${subject}\n${email}`.toLowerCase()

  if (!email) findings.push({ case: c.name, severity: 'FAIL', message: 'empty email body' })

  // 1) No false industry leaked from the seller ICP.
  if (blob.includes('manufactur') && !c.expectIndustryAnyOf.some((t) => t.includes('manufactur'))) {
    findings.push({ case: c.name, severity: 'FAIL', message: 'leaked seller ICP industry ("manufactur…") onto a non-manufacturing prospect' })
  }

  // 2) Understood the real trade.
  if (!c.expectIndustryAnyOf.some((t) => blob.includes(t))) {
    findings.push({ case: c.name, severity: 'WARN', message: `did not reference the prospect's trade (expected one of: ${c.expectIndustryAnyOf.join(', ')})` })
  }

  // 3) No vague filler.
  for (const phrase of BANNED_FILLER) {
    if (blob.includes(phrase)) findings.push({ case: c.name, severity: 'FAIL', message: `used banned filler: "${phrase}"` })
  }

  // 4) Personal hook handling.
  const hook = c.input.notes?.trim()
  if (hook) {
    const token = hook.toLowerCase().includes('bni') ? 'bni' : null
    if (token && !blob.includes(token)) {
      findings.push({ case: c.name, severity: 'WARN', message: `a real hook was provided ("${hook}") but the email did not open with it` })
    }
  } else {
    // Cold: must not invent a prior relationship.
    if (/\b(great|good|nice) (to meet|meeting|seeing) you\b/i.test(email) || /last (week|time we)/i.test(email)) {
      findings.push({ case: c.name, severity: 'FAIL', message: 'fabricated a prior relationship on a cold email' })
    }
  }

  // 5) Exactly one clear ask (a question CTA).
  const questions = (email.match(/\?/g) ?? []).length
  if (questions === 0) findings.push({ case: c.name, severity: 'FAIL', message: 'no question CTA' })
  if (questions > 2) findings.push({ case: c.name, severity: 'WARN', message: `${questions} questions — likely more than one ask` })

  // 6) Brevity (prompt targets <90 words; allow slack).
  const words = email.split(/\s+/).filter(Boolean).length
  if (words > 120) findings.push({ case: c.name, severity: 'WARN', message: `email is ${words} words (target <90)` })

  return findings
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log('⏭  OPENAI_API_KEY not set — skipping outreach eval (set it to run).')
    process.exit(0)
  }

  console.log(`Running outreach quality eval (${CASES.length} cases, model=${process.env.OPENAI_MODEL || 'gpt-4o-mini'})\n`)
  const allFindings: Finding[] = []

  for (const c of CASES) {
    process.stdout.write(`• ${c.name} … `)
    try {
      const raw = await generateOutreach(c.input)
      const findings = evaluate(c, raw)
      allFindings.push(...findings)
      const fails = findings.filter((f) => f.severity === 'FAIL').length
      const warns = findings.filter((f) => f.severity === 'WARN').length
      console.log(fails ? `❌ ${fails} fail, ${warns} warn` : warns ? `⚠️  ${warns} warn` : '✅ pass')
      try {
        const p = JSON.parse(raw)
        console.log(`    subject: ${p.subject}`)
        console.log(`    email:   ${String(p.email).replace(/\s+/g, ' ').slice(0, 200)}…\n`)
      } catch { /* reported above */ }
    } catch (err) {
      allFindings.push({ case: c.name, severity: 'FAIL', message: `generation threw: ${err instanceof Error ? err.message : String(err)}` })
      console.log('❌ threw')
    }
  }

  const fails = allFindings.filter((f) => f.severity === 'FAIL')
  const warns = allFindings.filter((f) => f.severity === 'WARN')
  if (allFindings.length) {
    console.log('— Findings —')
    for (const f of allFindings) console.log(`  ${f.severity === 'FAIL' ? '❌' : '⚠️ '} [${f.case}] ${f.message}`)
  }
  console.log(`\nResult: ${fails.length} FAIL, ${warns.length} WARN across ${CASES.length} cases.`)
  process.exit(fails.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
