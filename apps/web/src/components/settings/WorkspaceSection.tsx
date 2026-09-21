import React from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'

export type WorkspaceForm = { name: string; slug: string; senderBusinessName: string; senderPostalAddress: string }

export function WorkspaceSection({ wsForm, setWsForm, saving, onSave }: {
  wsForm: WorkspaceForm
  setWsForm: React.Dispatch<React.SetStateAction<WorkspaceForm>>
  saving: boolean
  onSave: () => void
}) {
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Workspace</div>
      <div style={{ display: 'grid', gap: 12, maxWidth: 400, marginBottom: 16 }}>
        <div>
          <label style={s.label} htmlFor="settings-field-3">Workspace Name</label>
          <input id="settings-field-3" style={s.input} value={wsForm.name} onChange={e => setWsForm(f => ({ ...f, name: e.target.value }))} />
        </div>
        <div>
          <label style={s.label} htmlFor="settings-field-4">Slug</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: colors.textFaint, fontSize: 14 }}>acaos.app/</span>
            <input id="settings-field-4"
              style={{ ...s.input, flex: 1 }}
              value={wsForm.slug}
              onChange={e => setWsForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
            />
          </div>
        </div>
        <div>
          <label style={s.label} htmlFor="settings-field-5">Sender Business Name <span style={{ color: colors.textFaint, fontWeight: 400 }}>(CAN-SPAM / GDPR)</span></label>
          <input id="settings-field-5" style={s.input} placeholder="Acme Services LLC" value={wsForm.senderBusinessName} onChange={e => setWsForm(f => ({ ...f, senderBusinessName: e.target.value }))} />
        </div>
        <div>
          <label style={s.label} htmlFor="settings-field-6">Sender Postal Address</label>
          <input id="settings-field-6" style={s.input} placeholder="123 Main St, City, ST 00000, USA" value={wsForm.senderPostalAddress} onChange={e => setWsForm(f => ({ ...f, senderPostalAddress: e.target.value }))} />
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>Included in outbound email footer to meet commercial email regulations.</div>
        </div>
      </div>
      <button style={s.btn} disabled={saving} onClick={onSave}>
        {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save Workspace'}
      </button>
    </div>
  )
}
