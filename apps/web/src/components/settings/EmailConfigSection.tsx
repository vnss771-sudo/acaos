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

// One-click server settings for the common providers, so a non-technical user
// only has to type their address and password. Fills host/port/TLS only.
const PROVIDER_PRESETS: {
  id: string
  label: string
  note: string
  values: Pick<EmailConfigForm, 'smtpHost' | 'smtpPort' | 'smtpSecure' | 'imapHost' | 'imapPort' | 'imapSecure'>
}[] = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    note: 'Use an App Password, not your normal password (Google Account → Security → 2-Step Verification → App passwords).',
    values: { smtpHost: 'smtp.gmail.com', smtpPort: '587', smtpSecure: false, imapHost: 'imap.gmail.com', imapPort: '993', imapSecure: true },
  },
  {
    id: 'microsoft',
    label: 'Outlook / Microsoft 365',
    note: 'Your Microsoft 365 admin may need to allow "Authenticated SMTP" for this mailbox.',
    values: { smtpHost: 'smtp.office365.com', smtpPort: '587', smtpSecure: false, imapHost: 'outlook.office365.com', imapPort: '993', imapSecure: true },
  },
]

export function EmailConfigSection({ emailForm, setEmailForm, saving, onSave }: {
  emailForm: EmailConfigForm
  setEmailForm: React.Dispatch<React.SetStateAction<EmailConfigForm>>
  saving: boolean
  onSave: () => void
}) {
  const [presetNote, setPresetNote] = React.useState<string | null>(null)

  function applyPreset(preset: typeof PROVIDER_PRESETS[number]) {
    setEmailForm(f => ({ ...f, ...preset.values }))
    setPresetNote(preset.note)
  }

  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Email Configuration</div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
        Connect the email account ACAOS should send from. <strong>Sending (SMTP)</strong> delivers the emails you approve;{' '}
        <strong>receiving (IMAP)</strong> lets ACAOS pick up replies and sort them in your Inbox.
        Your passwords are stored encrypted.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: presetNote ? 8 : 16 }}>
        <span style={{ color: colors.textFaint, fontSize: 12 }}>Quick setup:</span>
        {PROVIDER_PRESETS.map(p => (
          <button key={p.id} type="button" style={{ ...s.btnGhost, fontSize: 12, padding: '4px 10px' }} onClick={() => applyPreset(p)}>
            {p.label}
          </button>
        ))}
        <span style={{ color: colors.textFaint, fontSize: 12 }}>— or enter your provider's settings below.</span>
      </div>
      {presetNote && (
        <div role="status" style={{ color: colors.blueLight, fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
          Server settings filled in. Now add your email address as the username and from-address, and your password. {presetNote}
        </div>
      )}

      <div style={{ display: 'grid', gap: 16 }}>
        <div>
          <div style={{ color: colors.text, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Sending — SMTP (outbound)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { label: 'Host', field: 'smtpHost', placeholder: 'smtp.gmail.com' },
              { label: 'Port', field: 'smtpPort', placeholder: '587' },
              { label: 'Username', field: 'smtpUser', placeholder: 'you@gmail.com' },
              { label: emailForm.smtpPassSet ? 'Password (leave blank to keep)' : 'Password', field: 'smtpPass', placeholder: '••••••••' },
              { label: 'From Address', field: 'smtpFrom', placeholder: 'You <you@company.com>' },
            ].map(({ label, field, placeholder }) => (
              <div key={field} style={field === 'smtpFrom' ? { gridColumn: '1/-1' } : {}}>
                <label style={s.label} htmlFor={`email-config-${field}`}>{label}</label>
                <input id={`email-config-${field}`}
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
          <div style={{ color: colors.text, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Receiving replies — IMAP (inbound)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { label: 'Host', field: 'imapHost', placeholder: 'imap.gmail.com' },
              { label: 'Port', field: 'imapPort', placeholder: '993' },
              { label: 'Username', field: 'imapUser', placeholder: 'you@gmail.com' },
              { label: emailForm.imapPassSet ? 'Password (leave blank to keep)' : 'Password', field: 'imapPass', placeholder: '••••••••' },
            ].map(({ label, field, placeholder }) => (
              <div key={field}>
                <label style={s.label} htmlFor={`email-config-${field}`}>{label}</label>
                <input id={`email-config-${field}`}
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
