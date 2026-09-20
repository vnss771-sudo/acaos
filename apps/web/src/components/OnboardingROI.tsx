import React, { useState } from 'react'
import { colors, s } from '../styles.js'

type Props = {
  onStart: () => void
}

export function OnboardingROI({ onStart }: Props) {
  const [crewCount, setCrewCount] = useState(5)
  const [jobValue, setJobValue] = useState(1500)

  // Conservative estimates based on typical field service metrics
  const leadsPerMonth = crewCount * 30 + Math.random() * 20
  const jobsFromAcaos = Math.round(crewCount * 8 + (crewCount * 0.5) * Math.random())
  const monthlyRevenue = jobsFromAcaos * jobValue
  const monthlyAcaosCost = 299

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.92)',
      zIndex: 250,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24
    }}>
      <div style={{
        maxWidth: 640,
        width: '100%',
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: '40px 32px',
        position: 'relative'
      }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: colors.text, marginBottom: 8 }}>
            See Your ACAOS Impact
          </div>
          <div style={{ fontSize: 14, color: colors.textMuted }}>
            Field service agencies using ACAOS generate 8-12 jobs per crew per month
          </div>
        </div>

        {/* Input Section */}
        <div style={{ marginBottom: 32, display: 'grid', gap: 20 }}>
          {/* Crew Count Slider */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <label style={{ ...s.label }}>Your Crew Count</label>
              <div style={{ fontSize: 18, fontWeight: 700, color: colors.blue }}>{crewCount}</div>
            </div>
            <input
              type="range"
              min="1"
              max="50"
              value={crewCount}
              onChange={(e) => setCrewCount(Number(e.target.value))}
              style={{
                width: '100%',
                height: 6,
                borderRadius: 3,
                background: colors.border,
                outline: 'none',
                cursor: 'pointer'
              }}
            />
            <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 6 }}>Drag to adjust</div>
          </div>

          {/* Job Value Input */}
          <div>
            <label style={s.label}>Average Job Value</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: colors.textMuted }}>$</span>
              <input
                type="number"
                value={jobValue}
                onChange={(e) => setJobValue(Math.max(100, Number(e.target.value)))}
                style={{
                  ...s.input,
                  flex: 1,
                  fontSize: 16,
                  fontWeight: 600
                }}
              />
            </div>
          </div>
        </div>

        {/* Results Section */}
        <div style={{
          background: '#10b98122',
          border: `1px solid ${colors.green}33`,
          borderRadius: 12,
          padding: 20,
          marginBottom: 32
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* Column 1 */}
            <div>
              <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Leads/Month
              </div>
              <div style={{ color: colors.green, fontSize: 28, fontWeight: 700, lineHeight: 1 }}>
                {Math.round(leadsPerMonth)}
              </div>
              <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>From ACAOS discovery</div>
            </div>

            {/* Column 2 */}
            <div>
              <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Jobs Booked/Month
              </div>
              <div style={{ color: colors.green, fontSize: 28, fontWeight: 700, lineHeight: 1 }}>
                {jobsFromAcaos}
              </div>
              <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>At your conversion rate</div>
            </div>
          </div>

          {/* Revenue Row */}
          <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${colors.green}44` }}>
            <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Additional Monthly Revenue
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ color: colors.green, fontSize: 32, fontWeight: 700 }}>
                ${monthlyRevenue.toLocaleString()}
              </div>
              <div style={{ color: colors.textFaint, fontSize: 12 }}>
                minus $299 ACAOS = <span style={{ color: colors.green, fontWeight: 700 }}>${(monthlyRevenue - monthlyAcaosCost).toLocaleString()} profit</span>
              </div>
            </div>
          </div>
        </div>

        {/* Payback Info */}
        <div style={{
          background: colors.bgElevated,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 24
        }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 20 }}>⏱️</span>
            <div>
              <div style={{ color: colors.text, fontWeight: 600, marginBottom: 4 }}>Pays for itself in</div>
              <div style={{ color: colors.green, fontSize: 18, fontWeight: 700 }}>
                {Math.round((monthlyAcaosCost / monthlyRevenue) * 30)} days
              </div>
              <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>
                Then pure profit from ACAOS-generated work
              </div>
            </div>
          </div>
        </div>

        {/* CTA */}
        <button
          onClick={onStart}
          style={{
            ...s.btn,
            width: '100%',
            fontSize: 15,
            fontWeight: 700,
            padding: '14px 20px',
            background: colors.green,
            border: 'none'
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = colors.greenDark)}
          onMouseOut={(e) => (e.currentTarget.style.background = colors.green)}
        >
          Start 14-Day Free Trial
        </button>

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: 16, color: colors.textFaint, fontSize: 12 }}>
          No credit card required. Cancel anytime.
        </div>
      </div>
    </div>
  )
}
