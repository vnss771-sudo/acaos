import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

// Keeps keyboard focus inside `containerRef` while `active`: Tab/Shift+Tab
// cycle only through its focusable descendants (instead of escaping to
// whatever renders behind the overlay), focus moves into it on activation,
// and the element that had focus before is restored on deactivation. A11y
// requirement for any full-screen dialog/overlay — Modal, Drawer,
// CommandPalette all render a scrim over the rest of the app with nothing
// previously stopping Tab from reaching it.
export function useFocusTrap(containerRef: React.RefObject<HTMLElement | null>, active: boolean): void {
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    previouslyFocused.current = document.activeElement as HTMLElement | null

    if (container && !container.contains(document.activeElement)) {
      const first = focusableElements(container)[0]
      ;(first ?? container).focus()
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !container) return
      const els = focusableElements(container)
      if (els.length === 0) { e.preventDefault(); return }
      const first = els[0]!
      const last = els[els.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused.current?.focus?.()
    }
  }, [active, containerRef])
}
