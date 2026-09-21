import React from 'react'
import { s } from '../../styles.js'

export type NewLeadForm = {
  businessName: string; contactName: string; email: string; phone: string
  website: string; city: string; category: string; notes: string; score: string
}

export function AddLeadForm({ form, setForm, saving, onSave, onCancel }: {
  form: NewLeadForm
  setForm: React.Dispatch<React.SetStateAction<NewLeadForm>>
  saving: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const ff = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>New Lead</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Business Name *', field: 'businessName' },
          { label: 'Contact Name', field: 'contactName' },
          { label: 'Email', field: 'email' },
          { label: 'Phone', field: 'phone' },
          { label: 'Website', field: 'website' },
          { label: 'City', field: 'city' },
          { label: 'Category', field: 'category' }
        ].map(({ label, field }) => (
          <div key={field}>
            <label style={s.label} htmlFor="leads-field-3">{label}</label>
            <input id="leads-field-3" style={s.input} value={(form as Record<string, string>)[field]} onChange={ff(field)} />
          </div>
        ))}
        <div style={{ gridColumn: '1/-1' }}>
          <label style={s.label} htmlFor="leads-field-4">Notes</label>
          <textarea id="leads-field-4" style={{ ...s.textarea, height: 60 }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button style={s.btn} disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save Lead'}</button>
        <button style={{ ...s.btn, background: '#1f2937' }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
