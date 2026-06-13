/** RFC 4180-safe CSV cell serializer shared by all export endpoints. */
export function escCsv(v: unknown): string {
  const s = v == null ? '' : String(v)
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
}
