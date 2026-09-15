import React from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'

export type EmailConfigForm = {
  smtpHost: string
  smtpPort: string
  smtpSecure: boolean
  smtpUser: string
  smtpPass: string
  smtpFrom: string
  imapHost: string
  imapPort: string
  imapSecure: boolean
  imapUser: string
  imapPass: string
  smtpPassSet: boolean
  imapPassSet: boolean
}

export function EmailConfigSection({ emailForm, setEmailForm, saving, onSave }: {
  emailForm: EmailConfigForm
  setEmailForm: React.Dispatch<React.SetStateAction<EmailConfigForm>>
  saving: boolean
  onSave: () => void
}) {
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Email Configuration</div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
        Per-workspace SMTP/IMAP settings. Leave blank to use the server defaults.
      </div>
      <div style={{ display: 'grid', gap: 16 }}>
        <div>
          <div style={{ color: colors.text, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>SMTP (outbound)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { label: 'Host', field: 'smtpHost', placeholder: 'smtp.gmail.com' },
              { label: 'Port', field: 'smtpPort', placeholder: '587' },
              { label: 'Username', field: 'smtpUser', placeholder: 'you@gmail.com' },
              { label: emailForm.smtpPassSet ? 'Password (leave blank to keep)' : 'Password', field: 'smtpPass', placeholder: '••••••••' },
              { label: 'From Address', field: 'smtpFrom', placeholder: 'You <you@company.com>' },
            ].map(({ label, field, placeholder }) => (
              <div key={field} style={field === 'smtpFrom' ? { gridColumn: '1/-1' } : {}}>
                <label style={s.label} htmlFor="settings-field-15">{label}</label>
                <input id="settings-field-15"
                  style={s.input}
                  type={field === 'smtpPass' ? 'password' : 'text'}
                  placeholder={placeholder}
                  value={(emailForm as Record<string, unknown>)[field] as string}
                  onChange={e => setEmailForm(f => ({ ...f, [field]: e.target.value }))}
                  autoComplete={field === 'smtpPass' ? 'new-password' : 'off'}
                />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, gridColumn: '1/-1' }}>
              <input
                type="checkbox"
                id="smtpSecure"
                checked={emailForm.smtpSecure}
                onChange={e => setEmailForm(f => ({ ...f, smtpSecure: e.target.checked }))}
                style={{ accentColor: colors.blue, width: 16, height: 16 }}
              />
              <label htmlFor="smtpSecure" style={{ ...s.label, marginBottom: 0, cursor: 'pointer' }}>
                Use SSL/TLS (port 465)
              </label>
            </div>
          </div>
        </div>
        <div>
          <div style={{ color: colors.text, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>IMAP (inbound reply tracking)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { label: 'Host', field: 'imapHost', placeholder: 'imap.gmail.com' },
              { label: 'Port', field: 'imapPort', placeholder: '993' },
              { label: 'Username', field: 'imapUser', placeholder: 'you@gmail.com' },
              { label: emailForm.imapPassSet ? 'Password (leave blank to keep)' : 'Password', field: 'imapPass', placeholder: '••••••••' },
            ].map(({ label, field, placeholder }) => (
              <div key={field}>
                <label style={s.label} htmlFor="settings-field-16">{label}</label>
                <input id="settings-field-16"
                  style={s.input}
                  type={field === 'imapPass' ? 'password' : 'text'}
                  placeholder={placeholder}
                  value={(emailForm as Record<string, unknown>)[field] as string}
                  onChange={e => setEmailForm(f => ({ ...f, [field]: e.target.value }))}
                  autoComplete={field === 'imapPass' ? 'new-password' : 'off'}
                />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, gridColumn: '1/-1' }}>
              <input
                type="checkbox"
                id="imapSecure"
                checked={emailForm.imapSecure}
                onChange={e => setEmailForm(f => ({ ...f, imapSecure: e.target.checked }))}
                style={{ accentColor: colors.blue, width: 16, height: 16 }}
              />
              <label htmlFor="imapSecure" style={{ ...s.label, marginBottom: 0, cursor: 'pointer' }}>
                Use SSL/TLS (port 993)
              </label>
            </div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <button style={s.btn} disabled={saving} onClick={onSave}>
          {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save Email Config'}
        </button>
      </div>
    </div>
  )
}
