import { useEffect } from 'react'

// Call `handler` when Escape is pressed while `active` is true. Used to make
// modal/overlay dialogs dismissable from the keyboard (a11y: a keyboard user
// must be able to close a dialog without a pointer).
export function useEscapeKey(handler: () => void, active = true): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handler() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handler, active])
}
