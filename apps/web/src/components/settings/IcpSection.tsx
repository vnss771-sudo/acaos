import React from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'

export type IcpForm = { targetIndustries: string; targetGeos: string; minEmployees: string; maxEmployees: string; mustHaveEmail: boolean }

export function IcpSection({ icpForm, setIcpForm, saving, onSave }: {
  icpForm: IcpForm
  setIcpForm: React.Dispatch<React.SetStateAction<IcpForm>>
  saving: boolean
  onSave: () => void
}) {
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Ideal Customer Profile (ICP)</div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
        Defines the types of prospects ACAOS targets when scoring and filtering leads.
      </div>
      <div style={{ display: 'grid', gap: 12, maxWidth: 500, marginBottom: 16 }}>
        <div>
          <label style={s.label} htmlFor="settings-field-11">Target Industries (comma-separated)</label>
          <input id="settings-field-11"
            style={s.input}
            placeholder="e.g. HVAC, Electrical, Plumbing"
            value={icpForm.targetIndustries}
            onChange={e => setIcpForm(f => ({ ...f, targetIndustries: e.target.value }))}
          />
        </div>
        <div>
          <label style={s.label} htmlFor="settings-field-12">Target Geographies (comma-separated)</label>
          <input id="settings-field-12"
            style={s.input}
            placeholder="e.g. Brisbane, Sydney, Melbourne"
            value={icpForm.targetGeos}
            onChange={e => setIcpForm(f => ({ ...f, targetGeos: e.target.value }))}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={s.label} htmlFor="settings-field-13">Min Employees</label>
            <input id="settings-field-13"
              style={s.input}
              type="number"
              min="0"
              placeholder="e.g. 5"
              value={icpForm.minEmployees}
              onChange={e => setIcpForm(f => ({ ...f, minEmployees: e.target.value }))}
            />
          </div>
          <div>
            <label style={s.label} htmlFor="settings-field-14">Max Employees</label>
            <input id="settings-field-14"
              style={s.input}
              type="number"
              min="0"
              placeholder="e.g. 200"
              value={icpForm.maxEmployees}
              onChange={e => setIcpForm(f => ({ ...f, maxEmployees: e.target.value }))}
            />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            id="mustHaveEmail"
            checked={icpForm.mustHaveEmail}
            onChange={e => setIcpForm(f => ({ ...f, mustHaveEmail: e.target.checked }))}
            style={{ accentColor: colors.blue, width: 16, height: 16 }}
          />
          <label htmlFor="mustHaveEmail" style={{ ...s.label, marginBottom: 0, cursor: 'pointer' }}>
            Only score prospects that have an email address
          </label>
        </div>
      </div>
      <button style={s.btn} disabled={saving} onClick={onSave}>
        {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save ICP'}
      </button>
    </div>
  )
}
