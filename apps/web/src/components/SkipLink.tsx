import React from 'react'

// Keyboard accessibility: a skip link is the first focusable element on the
// page, letting keyboard/screen-reader users jump past the nav straight to the
// main content. Hidden until focused (see .skip-link in a11y.css).
export function SkipLink() {
  return (
    <a className="skip-link" href="#main-content">
      Skip to main content
    </a>
  )
}
