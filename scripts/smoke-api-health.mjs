import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'

const port = randomInt(4100, 4900)
const env = {
  ...process.env,
  PORT: String(port),
  WEB_URL: `http://localhost:${port + 1}`,
  JWT_SECRET: 'smoke-secret'
}

const child = spawn('npx', ['tsx', 'apps/api/src/server.ts'], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})

let finished = false

function cleanup(code = 0) {
  if (finished) return
  finished = true

  if (!child.killed) {
    child.kill('SIGTERM')
  }

  setTimeout(() => process.exit(code), 100)
}

child.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  process.stdout.write(text)
  if (text.includes('API running on')) {
    void runCheck()
  }
})

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk.toString())
})

child.on('exit', (code) => {
  if (!finished) {
    process.exit(code ?? 1)
  }
})

process.on('SIGINT', () => cleanup(1))
process.on('SIGTERM', () => cleanup(1))

async function runCheck() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    const data = await response.json()
    if (!response.ok || data.ok !== true) {
      throw new Error(`Unexpected response: ${JSON.stringify(data)}`)
    }
    console.log('Smoke OK:', JSON.stringify(data))
    cleanup(0)
  } catch (error) {
    console.error(error)
    cleanup(1)
  }
}

setTimeout(() => {
  if (!finished) {
    console.error('Timed out waiting for API startup')
    cleanup(1)
  }
}, 10000)
