import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const workflowsDir = path.join(root, '.github', 'workflows')
const workflowFiles = fs.existsSync(workflowsDir)
  ? fs.readdirSync(workflowsDir).filter((name) => /\.(ya?ml)$/i.test(name)).sort()
  : []

if (workflowFiles.length === 0) {
  console.error('No workflow files found under .github/workflows.')
  process.exit(1)
}

const pinPattern = /^[0-9a-f]{40}$/
const violations = []

for (const fileName of workflowFiles) {
  const filePath = path.join(workflowsDir, fileName)
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/)
    if (!match) continue

    const spec = match[1]
    if (spec.startsWith('./') || spec.startsWith('docker://')) continue

    const at = spec.lastIndexOf('@')
    if (at === -1) {
      violations.push(`${fileName}:${index + 1} -> missing @ref for ${spec}`)
      continue
    }

    const ref = spec.slice(at + 1)
    if (!pinPattern.test(ref)) {
      violations.push(`${fileName}:${index + 1} -> action ref must be pinned to a 40-char commit SHA (${spec})`)
    }
  }
}

if (violations.length > 0) {
  console.error('Workflow action pinning check failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`Workflow action pinning check passed for ${workflowFiles.length} workflow file(s).`)
