import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const EXPECTED = Object.freeze({
  nodeMajor: 26,
  npm: '10.9.2',
  typescript: '6.0.3',
  prisma: '5.22.0',
  prismaClient: '5.22.0',
  vite: '8.3.2',
  vitest: '4.1.11',
  playwright: '1.63.0',
  tsx: '4.22.4',
});

const runtimeOnly = process.argv.includes('--runtime-only');
const staticOnly = process.argv.includes('--static-only');
const failures = [];
const checks = [];

function pass(name, detail) { checks.push({ status: 'PASS', name, detail }); }
function fail(name, detail) { checks.push({ status: 'FAIL', name, detail }); failures.push(`${name}: ${detail}`); }
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function exact(name, actual, expected) {
  if (actual === expected) pass(name, actual);
  else fail(name, `expected ${expected}, found ${actual ?? '<missing>'}`);
}

if (!staticOnly) {
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (nodeMajor === EXPECTED.nodeMajor) pass('Node runtime', nodeVersion);
  else fail('Node runtime', `expected major ${EXPECTED.nodeMajor}, found ${nodeVersion}`);
  try {
    const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
    exact('npm runtime', npmVersion, EXPECTED.npm);
  } catch (error) {
    fail('npm runtime', error instanceof Error ? error.message : String(error));
  }
}

if (!runtimeOnly) {
  const rootPkg = readJson('package.json');
  exact('packageManager', rootPkg.packageManager, `npm@${EXPECTED.npm}`);
  exact('root TypeScript pin', rootPkg.devDependencies?.typescript, EXPECTED.typescript);
  exact('Node engine', rootPkg.engines?.node, '>=26 <27');
  exact('npm engine', rootPkg.engines?.npm, EXPECTED.npm);

  for (const rel of [
    'apps/api/package.json',
    'apps/web/package.json',
    'apps/worker/package.json',
    'packages/backend-core/package.json',
  ]) {
    const pkg = readJson(rel);
    exact(`${rel} TypeScript pin`, pkg.devDependencies?.typescript, EXPECTED.typescript);
  }

  const lock = readJson('package-lock.json');
  exact('lock root TypeScript declaration', lock.packages?.['']?.devDependencies?.typescript, EXPECTED.typescript);
  exact('lock root TypeScript resolution', lock.packages?.['node_modules/typescript']?.version, EXPECTED.typescript);
  exact('Prisma CLI resolution', lock.packages?.['node_modules/prisma']?.version, EXPECTED.prisma);
  exact('Prisma client resolution', lock.packages?.['node_modules/@prisma/client']?.version, EXPECTED.prismaClient);
  exact('Vite resolution', lock.packages?.['node_modules/vite']?.version, EXPECTED.vite);
  exact('Vitest resolution', lock.packages?.['node_modules/vitest']?.version, EXPECTED.vitest);
  exact('Playwright resolution', lock.packages?.['node_modules/@playwright/test']?.version, EXPECTED.playwright);
  exact('tsx resolution', lock.packages?.['node_modules/tsx']?.version, EXPECTED.tsx);

  const nvmrc = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();
  exact('.nvmrc', nvmrc, String(EXPECTED.nodeMajor));

  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  if (ci.includes("NODE_VERSION: '26'")) pass('CI Node pin', '26');
  else fail('CI Node pin', 'NODE_VERSION is not 26');
  if (ci.includes("NPM_VERSION: '10.9.2'")) pass('CI npm pin', EXPECTED.npm);
  else fail('CI npm pin', `NPM_VERSION is not ${EXPECTED.npm}`);

  for (const rel of ['Dockerfile.api', 'Dockerfile.worker', 'Dockerfile.web']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/FROM node:26-alpine@sha256:/.test(text)) pass(`${rel} Node base`, 'node:26-alpine digest-pinned');
    else fail(`${rel} Node base`, 'builder/runtime Node base is not node:26-alpine digest-pinned');
    if (text.includes('ARG NPM_VERSION=10.9.2') && text.includes('npm install --global npm@${NPM_VERSION}')) {
      pass(`${rel} npm pin`, EXPECTED.npm);
    } else {
      fail(`${rel} npm pin`, `builder does not pin npm ${EXPECTED.npm}`);
    }
  }
}

for (const check of checks) {
  console.log(`[${check.status}] ${check.name}: ${check.detail}`);
}
if (failures.length) {
  console.error(`\nToolchain contract failed (${failures.length} check${failures.length === 1 ? '' : 's'}).`);
  process.exit(1);
}
console.log('\nToolchain contract PASS.');
