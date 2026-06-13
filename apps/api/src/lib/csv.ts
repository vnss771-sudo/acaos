/** RFC 4180-safe CSV cell serializer shared by all export endpoints. */
export function escCsv(v: unknown): string {
  const s = v == null ? '' : String(v)
  // Also wrap = prefix to defeat spreadsheet formula injection
  const needsQuote = s.includes(',') || s.includes('"') || s.includes('\n') || s.startsWith('=')
  return needsQuote ? `"${s.replace(/"/g, '""')}"` : s
}
