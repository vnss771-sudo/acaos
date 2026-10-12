import React from 'react'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuComplianceSection, type AuPosture } from './AuComplianceSection.js'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
afterEach(() => { vi.restoreAllMocks(); Object.values(toast).forEach(f => f.mockClear()) })

const ws = { id: 'ws1', name: 'Acme', slug: 'acme', plan: 'starter', senderBusinessName: 'Acme Electrical Pty Ltd' } as never
const posture = (over: Partial<AuPosture> = {}): AuPosture => ({
  targetsAustralia: false, senderAbn: null, senderAbnStatus: null, senderAbnEntityName: null, senderAbnVerifiedAt: null, ...over,
})
const readiness = (auOk: boolean) => ({
  ready: false,
  checks: [
    { name: 'smtpConfigured', label: 'Email sending configured', ok: true },
    { name: 'auCommercialSending', label: 'Australian commercial sending (Spam Act 2003)', ok: auOk, hint: 'Sending to Australian recipients is disabled pending legal review.' },
  ],
})
const record = (over: Record<string, unknown> = {}) => ({
  id: 'c1', email: 'info@acme.test', basis: 'inferred_conspicuous_publication', source: 'manual', recordedAt: '2026-10-01T00:00:00Z',
  evidenceUrl: 'https://acme.test/contact', evidenceAt: '2026-09-30T00:00:00Z', evidenceExcerpt: null, addressType: 'role',
  optOutStatementAbsent: true, roleRelevant: true, qualifiesForAustralia: true, australiaReasons: [], ...over,
})

type Handler = (path: string, init?: { method?: string; body?: string }) => unknown
function makeApi(over: Record<string, Handler> = {}, records: unknown[] = [], auOk = false) {
  const handler: Handler = (path, init) => {
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`
    if (over[key]) return over[key](path, init)
    if (key === 'GET /api/campaigns/send-readiness') return readiness(auOk)
    if (key === 'GET /api/workspaces/ws1/consent') return { total: records.length, records }
    throw new Error(`unexpected ${key}`)
  }
  return vi.fn((path: string, init?: { method?: string; body?: string }) => {
    try { return Promise.resolve(handler(path, init)) } catch (e) { return Promise.reject(e) }
  })
}
const renderIt = (api: ReturnType<typeof makeApi>, p = posture(), canManage = true, onPosture = vi.fn()) =>
  render(<AuComplianceSection api={api as never} workspace={ws} toast={toast as never} canManage={canManage} posture={p} onPosture={onPosture} />)

describe('AuComplianceSection — ABN', () => {
  test('verify shows loading, then the verified entity, status and date; posts only the ABN', async () => {
    let release!: (v: unknown) => void
    const pending = new Promise(r => { release = r })
    const api = makeApi({ 'POST /api/workspaces/ws1/compliance/abn': () => pending })
    const onPosture = vi.fn()
    renderIt(api, posture(), true, onPosture)
    await userEvent.type(screen.getByLabelText('ABN'), '51 824 753 556')
    await userEvent.click(screen.getByRole('button', { name: 'Verify ABN' }))
    expect(await screen.findByText(/Checking the Australian Business Register/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Verifying/ })).toBeDisabled()
    release({ abn: '51824753556', status: 'active', entityName: 'ACME PTY LTD', entityType: 'Australian Private Company' })
    await waitFor(() => expect(onPosture).toHaveBeenCalledWith(expect.objectContaining({ senderAbn: '51824753556', senderAbnStatus: 'active', senderAbnEntityName: 'ACME PTY LTD' })))
    const call = api.mock.calls.find(c => String(c[0]).endsWith('/compliance/abn'))!
    expect(JSON.parse(call[1]!.body!)).toEqual({ abn: '51 824 753 556' })
    expect(JSON.stringify(api.mock.calls)).not.toMatch(/guid/i)
  })

  test('renders a verified ABN with entity name, Active badge, verification date and the no-endorsement note', () => {
    renderIt(makeApi(), posture({ senderAbn: '51824753556', senderAbnStatus: 'active', senderAbnEntityName: 'ACME PTY LTD', senderAbnVerifiedAt: '2026-10-12T00:00:00Z' }))
    expect(screen.getByText('ACME PTY LTD')).toBeInTheDocument()
    expect(screen.getByText(/ABN 51 824 753 556/)).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText(/does not mean the Commonwealth endorses/)).toBeInTheDocument()
  })

  test('failure shows the server message and clears a stored ABN when it is cancelled', async () => {
    const api = makeApi({ 'POST /api/workspaces/ws1/compliance/abn': () => { throw new Error('That ABN is cancelled, so it will not be shown in your email footer') } })
    const onPosture = vi.fn()
    renderIt(api, posture({ senderAbn: '51824753556', senderAbnStatus: 'active', senderAbnEntityName: 'X', senderAbnVerifiedAt: '2026-10-12T00:00:00Z' }), true, onPosture)
    await userEvent.click(screen.getByRole('button', { name: 'Verify ABN' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cancelled/)
    expect(onPosture).toHaveBeenCalledWith(expect.objectContaining({ senderAbn: null, senderAbnStatus: null }))
  })

  test('other failures (not found / not configured) show the message and keep existing state', async () => {
    const api = makeApi({ 'POST /api/workspaces/ws1/compliance/abn': () => { throw new Error('ABN verification is not configured on this server') } })
    const onPosture = vi.fn()
    renderIt(api, posture(), true, onPosture)
    await userEvent.type(screen.getByLabelText('ABN'), '51824753556')
    await userEvent.click(screen.getByRole('button', { name: 'Verify ABN' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured/)
    expect(onPosture).not.toHaveBeenCalled()
    expect(screen.getByText(/No verified ABN/)).toBeInTheDocument()
  })

  test('saving the legal name patches the workspace', async () => {
    const api = makeApi({ 'PATCH /api/workspaces/ws1': () => ({}) })
    renderIt(api)
    const input = screen.getByLabelText('Business legal name')
    await userEvent.clear(input); await userEvent.type(input, 'New Name Pty Ltd')
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!)
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/workspaces/ws1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ senderBusinessName: 'New Name Pty Ltd' }) })))
  })
})

describe('AuComplianceSection — role-based access', () => {
  test('a non-manager sees everything read-only: disabled inputs and no evidence form', async () => {
    renderIt(makeApi({}, [record()]), posture(), false)
    expect(screen.getByLabelText('Business legal name')).toBeDisabled()
    expect(screen.getByLabelText('ABN')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Verify ABN' })).toBeDisabled()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.queryByRole('form', { name: 'Record consent evidence' })).toBeNull()
    expect(await screen.findByText('info@acme.test')).toBeInTheDocument()
  })
})

describe('AuComplianceSection — targeting + readiness', () => {
  test('toggling Australian targeting patches the compliance API and warns that sending is blocked while disabled', async () => {
    const api = makeApi({ 'PATCH /api/workspaces/ws1/compliance': () => ({ posture: {} }) })
    const onPosture = vi.fn()
    renderIt(api, posture(), true, onPosture)
    await userEvent.click(screen.getByRole('checkbox', { name: /Australian link/ }))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/workspaces/ws1/compliance', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ targetsAustralia: true }) })))
    expect(onPosture).toHaveBeenCalledWith({ targetsAustralia: true })
  })

  test('Australian targeting cannot be switched off through the settings checkbox', () => {
    renderIt(makeApi({}, [], false), posture({ targetsAustralia: true }))
    expect(screen.getByRole('checkbox', { name: /Australian link/ })).toBeDisabled()
    expect(screen.getByText(/locked on once enabled/)).toBeInTheDocument()
  })

  test('with targeting on and AU sending disabled, the blocked-send explanation and failing readiness check are shown', async () => {
    renderIt(makeApi({}, [], false), posture({ targetsAustralia: true }))
    expect(await screen.findByText(/Sending is currently blocked for this workspace/)).toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Send readiness' })
    expect(within(list).getByText(/✗ Australian commercial sending/)).toBeInTheDocument()
    expect(within(list).getByText('Not ready to send')).toBeInTheDocument()
  })

  test('when AU sending is enabled server-side the explanation switches to per-recipient evidence', async () => {
    renderIt(makeApi({}, [], true), posture({ targetsAustralia: true }))
    expect(await screen.findByText(/needs qualifying consent evidence below/)).toBeInTheDocument()
  })
})

describe('AuComplianceSection — consent evidence', () => {
  async function fill() {
    await userEvent.type(screen.getByLabelText('Recipient email'), 'info@acme.test')
    await userEvent.type(screen.getByLabelText('Page URL where the address was published'), 'https://acme.test/contact')
    await userEvent.type(screen.getByLabelText('Date you saw it'), '2026-09-30')
    await userEvent.selectOptions(screen.getByLabelText('Address type'), 'role')
  }

  test('submits the evidence with the observation flags the user ticked', async () => {
    const api = makeApi({ 'POST /api/workspaces/ws1/consent': () => ({ id: 'c1', recordedAt: '2026-10-12T00:00:00Z' }) })
    renderIt(api)
    await fill()
    await userEvent.click(screen.getByLabelText(/no “no unsolicited commercial email”/))
    await userEvent.click(screen.getByLabelText(/relevant to this person/))
    await userEvent.click(screen.getByRole('button', { name: 'Record evidence' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Consent evidence recorded'))
    const call = api.mock.calls.find(c => c[1]?.method === 'POST')!
    expect(JSON.parse(call[1]!.body!)).toMatchObject({
      email: 'info@acme.test', basis: 'inferred_conspicuous_publication', source: 'manual', evidenceUrl: 'https://acme.test/contact',
      addressType: 'role', optOutStatementAbsent: true, roleRelevant: true,
    })
  })

  test('the UI does not bypass backend validation: unticked observations are sent as false and the server rejection is shown', async () => {
    const api = makeApi({ 'POST /api/workspaces/ws1/consent': () => { throw new Error('Insufficient Spam Act consent evidence: must be verified that no "no unsolicited commercial email" statement accompanies the address') } })
    renderIt(api)
    await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Record evidence' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Insufficient Spam Act consent evidence/)
    const call = api.mock.calls.find(c => c[1]?.method === 'POST')!
    expect(JSON.parse(call[1]!.body!)).toMatchObject({ optOutStatementAbsent: false, roleRelevant: false })
    expect(toast.success).not.toHaveBeenCalled()
  })

  test('express basis hides publication-only fields and sends none of them', async () => {
    const api = makeApi({ 'POST /api/workspaces/ws1/consent': () => ({ id: 'c2', recordedAt: '2026-10-12T00:00:00Z' }) })
    renderIt(api)
    await userEvent.selectOptions(screen.getByLabelText('Basis'), 'express')
    expect(screen.queryByLabelText('Address type')).toBeNull()
    await userEvent.type(screen.getByLabelText('Recipient email'), 'a@b.test')
    await userEvent.type(screen.getByLabelText(/Date consent was given/), '2026-09-30')
    await userEvent.type(screen.getByLabelText(/Excerpt/), 'Ticked "email me quotes" on the web form')
    await userEvent.click(screen.getByRole('button', { name: 'Record evidence' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const body = JSON.parse(api.mock.calls.find(c => c[1]?.method === 'POST')![1]!.body!)
    expect(body.basis).toBe('express')
    expect(body).not.toHaveProperty('addressType'); expect(body).not.toHaveProperty('roleRelevant')
  })

  test('review lists records with the server verdict and the reasons evidence is missing', async () => {
    renderIt(makeApi({}, [
      record(),
      record({ id: 'c2', email: 'thin@acme.test', qualifiesForAustralia: false, optOutStatementAbsent: null, australiaReasons: ['must be verified that no "no unsolicited commercial email" statement accompanies the address'] }),
      record({ id: 'c3', email: 'li@acme.test', basis: 'legitimate_interest', evidenceUrl: null, evidenceAt: null, addressType: null, qualifiesForAustralia: false, australiaReasons: ['Not an Australian consent basis: it does not authorise sends to Australian recipients'] }),
    ]))
    expect(await screen.findByText('Qualifies for Australia')).toBeInTheDocument()
    expect(screen.getAllByText('Not sufficient for Australia')).toHaveLength(2)
    expect(screen.getByText(/statement accompanies the address/)).toBeInTheDocument()
    expect(screen.getByText(/does not authorise sends to Australian recipients/)).toBeInTheDocument()
    expect(screen.getByText(/Legitimate interest \(does NOT count for Australia\)/)).toBeInTheDocument()
  })

  test('an empty list explains that Australian sends will be skipped', async () => {
    renderIt(makeApi())
    expect(await screen.findByText(/Without a qualifying record, Australian sends are skipped/)).toBeInTheDocument()
  })
})
