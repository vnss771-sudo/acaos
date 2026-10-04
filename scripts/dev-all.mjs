import { spawn } from 'node:child_process'

const services = [
  ['web', 'npm --workspace @acaos/web run dev'],
  ['api', 'npm --workspace @acaos/api run dev'],
  ['worker', 'npm --workspace @acaos/worker run dev'],
]

const children = services.map(([name, command]) => {
  const child = spawn(command, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`\n[dev] ${name} exited via ${signal}`)
      return
    }
    if (code !== 0) {
      console.log(`\n[dev] ${name} exited with code ${code}`)
    }
  })

  return child
})

let exiting = false

const shutdown = (signal) => {
  if (exiting) return
  exiting = true
  for (const child of children) {
    child.kill(signal)
  }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

let exitCode = 0
let completed = 0

for (const child of children) {
  child.on('exit', (code) => {
    completed += 1
    if (code !== 0 && exitCode === 0) {
      exitCode = code ?? 1
    }
    if (completed === children.length) {
      process.exit(exitCode)
    }
  })
}

console.log('[dev] Starting ACAOS services: web, api, worker')
