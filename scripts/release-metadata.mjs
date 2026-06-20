#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv.includes('--env') ? 'env' : 'json'
const manifestFlag = process.argv.indexOf('--manifest')
const manifestPath = manifestFlag >= 0 ? path.resolve(root, process.argv[manifestFlag + 1]) : null

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  return pkg.version || process.env.npm_package_version || '0.0.0-dev'
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim()
  } catch {
    return undefined
  }
}

function value(name, fallback) {
  const raw = process.env[name]?.trim()
  return raw || fallback
}

const version = value('ACAOS_RELEASE_VERSION', value('npm_package_version', readPackageVersion()))
const commit = value('ACAOS_RELEASE_SHA', value('GITHUB_SHA', git(['rev-parse', 'HEAD']) || 'unknown'))
const buildTime = value('ACAOS_BUILD_TIME', new Date().toISOString())
const releaseId = value('ACAOS_RELEASE_ID', commit && commit !== 'unknown' ? `${version}+${commit.slice(0, 12)}` : version)
const sourceRef = value('ACAOS_SOURCE_REF', value('GITHUB_REF_NAME', git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown'))

const metadata = {
  version,
  commit,
  buildTime,
  releaseId,
  sourceRef,
  generatedAt: new Date().toISOString(),
}

if (manifestPath) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`)
}

if (mode === 'env') {
  process.stdout.write([
    `ACAOS_RELEASE_VERSION=${version}`,
    `ACAOS_RELEASE_SHA=${commit}`,
    `ACAOS_BUILD_TIME=${buildTime}`,
    `ACAOS_RELEASE_ID=${releaseId}`,
    `ACAOS_SOURCE_REF=${sourceRef}`,
  ].join('\n') + '\n')
} else {
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`)
}
