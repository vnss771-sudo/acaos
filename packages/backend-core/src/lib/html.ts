// Minimal HTML escaping for interpolating untrusted values (workspace names,
// sender business name/address, user display names) into the HTML bodies of
// outbound emails. Escapes the single-quote too, so a value is safe in both
// element and single-quoted-attribute contexts. Canonical copy for backend-core;
// the API app's apps/api/src/lib/html.ts mirrors this for its own system emails.
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
