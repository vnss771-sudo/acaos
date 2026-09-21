import React from 'react'

type Props = {
  children: React.ReactNode
  // Custom fallback for a scoped boundary (e.g. one optional panel inside a
  // larger page) — when omitted, renders the full-page "Something went wrong"
  // screen used at the app root.
  fallback?: (error: Error | undefined) => React.ReactNode
}

// A crash inside one optional panel shouldn't take an entire page down with
// it — wrap anything whose failure mode should degrade locally (a compliance
// widget, a third-party embed, a chart fed by loosely-typed data) in its own
// ErrorBoundary with a compact `fallback`, separate from the app-root one.
export class ErrorBoundary extends React.Component<Props, { hasError: boolean; error?: Error }> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback(this.state.error)
      return (
        <div style={{ padding: '40px', textAlign: 'center', color: '#ef4444' }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>⚠</div>
          <div style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong</div>
          <div style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>{this.state.error?.message}</div>
          <button onClick={() => window.location.reload()} style={{ padding: '8px 20px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
