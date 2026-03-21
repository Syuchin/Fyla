import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const tagArg = process.argv[2] || process.env.GITHUB_REF_NAME || ''
const expectedVersion = process.env.RELEASE_VERSION || tagArg.replace(/^v/, '')

if (!expectedVersion) {
  console.error('[release-preflight] missing expected version or tag')
  process.exit(1)
}

if (tagArg && tagArg !== `v${expectedVersion}`) {
  console.error(`[release-preflight] tag ${tagArg} does not match version ${expectedVersion}`)
  process.exit(1)
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function parsePackageVersion(relativePath) {
  return JSON.parse(read(relativePath)).version
}

function parseCargoTomlVersion(relativePath) {
  const match = read(relativePath).match(/^version = "([^"]+)"/m)
  return match?.[1] || ''
}

function parseCargoLockVersion(relativePath) {
  const match = read(relativePath).match(/\[\[package\]\]\s+name = "fyla"\s+version = "([^"]+)"/m)
  return match?.[1] || ''
}

function parseTauriVersion(relativePath) {
  return JSON.parse(read(relativePath)).version
}

function parseChangelogVersion(relativePath) {
  const match = read(relativePath).match(/version:\s*'([^']+)'/)
  return match?.[1] || ''
}

const checks = [
  ['package.json', parsePackageVersion('package.json')],
  ['package-lock.json', parsePackageVersion('package-lock.json')],
  ['src-tauri/Cargo.toml', parseCargoTomlVersion('src-tauri/Cargo.toml')],
  ['src-tauri/Cargo.lock', parseCargoLockVersion('src-tauri/Cargo.lock')],
  ['src-tauri/tauri.conf.json', parseTauriVersion('src-tauri/tauri.conf.json')],
  ['src/lib/changelog.js', parseChangelogVersion('src/lib/changelog.js')],
]

const failures = checks.filter(([, actual]) => actual !== expectedVersion)

if (failures.length) {
  console.error(`[release-preflight] version mismatch for ${expectedVersion}`)
  for (const [name, actual] of failures) {
    console.error(`  - ${name}: ${actual || '<missing>'}`)
  }
  process.exit(1)
}

console.info(`[release-preflight] all version sources match ${expectedVersion}`)
