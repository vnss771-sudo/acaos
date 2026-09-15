// RFC-4180 compliant CSV parser. Handles quoted fields containing commas,
// newlines, and escaped double-quotes ("").
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  // The outer condition used to be `i <= line.length`. That off-by-one let the
  // loop run once more after the last field with line[i] as undefined, which
  // fell into the unquoted branch and pushed a spurious extra empty field
  // whenever a line ended on a quoted value — parsing `"a"` produced ['a', '']
  // instead of ['a']. A genuine trailing comma (`a,b,`) must still yield its
  // own trailing empty field though, including right after a quoted value
  // (`"a",` -> ['a', '']), so the quoted branch explicitly loops back (via
  // `continue`) after consuming a trailing comma instead of relying on one
  // more full outer-loop pass to pick it up.
  for (;;) {
    if (line[i] === '"') {
      let field = ''
      i++ // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"'; i += 2
        } else if (line[i] === '"') {
          i++; break
        } else {
          field += line[i++]
        }
      }
      fields.push(field)
      if (line[i] === ',') { i++; continue }
      break
    } else {
      const end = line.indexOf(',', i)
      if (end === -1) { fields.push(line.slice(i).trim()); break }
      fields.push(line.slice(i, end).trim())
      i = end + 1
    }
  }
  return fields
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0])
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
}
