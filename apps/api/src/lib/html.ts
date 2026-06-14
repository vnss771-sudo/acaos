// Minimal HTML escaping for interpolating untrusted values (workspace names,
// roles, user-supplied display names) into the HTML bodies of system emails.
// Prevents stored values from injecting markup or breaking out of attributes.

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] as string)
}
