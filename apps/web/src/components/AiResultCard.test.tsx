import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiResultCard, plainTextOf } from './AiResultCard.js'

const research = JSON.stringify({
  aiSummary: 'Lendlease is a major construction group.',
  outreachAngle: 'Managing communication across projects.',
  qualificationSignals: [],
  evidence: [{ signal: 'Operates in construction.', type: 'inferred', confidence: 'high' }],
  riskFlags: ['Operational pain is inferred from industry, not stated.'],
  recommendedAction: 'skip',
  confidence: 'medium',
  icpScore: 45,
  hiringSignals: false,
  digitalMaturity: 'high',
  estimatedTeamSize: '500+',
})

describe('AiResultCard', () => {
  test('research reads as a briefing, not JSON field names', () => {
    render(<AiResultCard raw={research} copied={false} onCopy={vi.fn()} />)

    expect(screen.getByText('Fit 45/100')).toBeInTheDocument()
    expect(screen.getByText('Lendlease is a major construction group.')).toBeInTheDocument()
    expect(screen.getByText('Best way in')).toBeInTheDocument()
    expect(screen.getByText(/Skip for now/)).toBeInTheDocument()
    expect(screen.getByText(/Operational pain is inferred/)).toBeInTheDocument()
    expect(screen.queryByText(/icpScore/)).not.toBeInTheDocument()
    expect(screen.queryByText(/recommendedAction/)).not.toBeInTheDocument()
  })

  test('technical details are hidden until asked for', async () => {
    render(<AiResultCard raw={research} copied={false} onCopy={vi.fn()} />)

    expect(screen.queryByText(/"icpScore"/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show technical details' }))
    expect(screen.getByText(/"icpScore": 45/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Hide technical details' }))
    expect(screen.queryByText(/"icpScore"/)).not.toBeInTheDocument()
  })

  test('outreach shows the subject and email as text', () => {
    const raw = JSON.stringify({ subject: 'scheduling for Acme', email: 'Hi Sam, quick question.', followup: 'Any thoughts?' })
    render(<AiResultCard raw={raw} copied={false} onCopy={vi.fn()} />)

    expect(screen.getByText('scheduling for Acme')).toBeInTheDocument()
    expect(screen.getByText('Hi Sam, quick question.')).toBeInTheDocument()
    expect(screen.getByText('Any thoughts?')).toBeInTheDocument()
  })

  test('reply analysis shows plain-language labels', () => {
    const raw = JSON.stringify({
      classification: 'NEEDS_MORE_INFO', confidence: 80, summary: 'They want pricing.',
      suggestedAction: 'Send the one-pager.', urgency: 'this_week', keyQuote: 'Can you send more info?', isAutoReply: false,
    })
    render(<AiResultCard raw={raw} copied={false} onCopy={vi.fn()} />)

    expect(screen.getByText('Wants more information')).toBeInTheDocument()
    expect(screen.getByText('Follow up this week')).toBeInTheDocument()
    expect(screen.getByText('Send the one-pager.')).toBeInTheDocument()
    expect(screen.queryByText('NEEDS_MORE_INFO')).not.toBeInTheDocument()
  })

  test('unrecognised or non-JSON results fall back to the raw text', () => {
    render(<AiResultCard raw="done" copied={false} onCopy={vi.fn()} />)
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /technical details/ })).not.toBeInTheDocument()
  })

  test('Copy puts readable text on the clipboard, not JSON', async () => {
    const onCopy = vi.fn()
    const raw = JSON.stringify({ subject: 'Hello', email: 'Body text', followup: 'Follow up text' })
    render(<AiResultCard raw={raw} copied={false} onCopy={onCopy} />)

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(onCopy).toHaveBeenCalledWith('Subject: Hello\n\nBody text\n\nFollow-up:\nFollow up text')
  })

  test('plainTextOf returns non-JSON input unchanged', () => {
    expect(plainTextOf('plain')).toBe('plain')
  })
})
