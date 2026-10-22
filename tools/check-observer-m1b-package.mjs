import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprintPluginDir } from '../orchestration/gate/preflight.mjs'

const MANIFEST_SCHEMA = 'tla.observer-m1b-package/v1'
const ENVELOPE_DIGEST = 'dc68af4508722c8452e84f4538dc215126c649771ea49d479f10be948e16f619'

class PackageError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'PackageError'
    this.code = code
  }
}

function fail (code, message) {
  throw new PackageError(code, message)
}

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonical (path) {
  return path.replaceAll('\\', '/')
}

function git (repo, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', repo, ...args], { encoding, stdio: ['ignore', 'pipe', 'pipe'] })
}

function loadManifest (repo) {
  const path = join(repo, 'docs', 'V0.2-OBSERVER-M1B-PACKAGE-MANIFEST.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('MANIFEST_UNREADABLE', 'M1B manifest could not be read: ' + String(error.message))
  }
  if (manifest.schema !== MANIFEST_SCHEMA) fail('MANIFEST_SCHEMA', 'unexpected manifest schema')
  if (!Array.isArray(manifest.files) || manifest.files.length !== 12) fail('MANIFEST_COUNT', 'M1B manifest must contain exactly 12 files')
  if (manifest.envelope === null || typeof manifest.envelope !== 'object') fail('MANIFEST_ENVELOPE', 'manifest.envelope is required')
  if (manifest.envelope.fileCount !== 12) fail('MANIFEST_COUNT', 'envelope.fileCount must be 12')
  return manifest
}

function verifyEntrySource (repo, base, entry) {
  if (typeof entry.source !== 'string' || entry.source === '' || isAbsolute(entry.source)) fail('SOURCE_PATH', 'entry source must be a relative path')
  if (!existsSync(join(repo, entry.source))) fail('SOURCE_MISSING', 'missing source: ' + entry.source)
  const bytes = readFileSync(join(repo, entry.source))
  if (bytes.length !== entry.bytes) fail('SOURCE_BYTES', 'source byte count changed: ' + entry.source)
  if (sha256(bytes) !== entry.sha256) fail('SOURCE_HASH', 'source hash changed: ' + entry.source)
  if (entry.blob !== null && entry.blob !== undefined && !/^[0-9a-f]{40}$/u.test(entry.blob)) fail('SOURCE_BLOB', 'invalid blob id: ' + entry.source)
  try {
    const actual = git(repo, ['rev-parse', base + ':' + entry.source]).trim()
    if (actual !== entry.blob) fail('SOURCE_BASE', 'manifest blob does not match sourceBase: ' + entry.source)
  } catch (error) {
    fail('SOURCE_BASE', 'sourceBase cannot resolve ' + entry.source + ': ' + String(error.message))
  }
}

function checkPackageJson (path) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('PACKAGE_JSON', 'root package.json is invalid: ' + String(error.message))
  }
  for (const key of ['name', 'version', 'private', 'type', 'main', 'exports']) {
    if (!(key in pkg)) fail('PACKAGE_JSON', 'root package.json is missing ' + key)
  }
  if (pkg.name !== 'tla-tool-observer' || pkg.version !== '0.0.0-local' || pkg.private !== true || pkg.type !== 'module') {
    fail('PACKAGE_JSON', 'root package identity is not the reviewed observer identity')
  }
  const main = typeof pkg.main === 'string' && pkg.main.startsWith('./') ? pkg.main : './' + String(pkg.main)
  if (main !== './orchestration/tool-observer/host-plugin/index.js') fail('PACKAGE_MAIN', 'root package main is not the observer entry')
  if (pkg.exports === null || typeof pkg.exports !== 'object' || pkg.exports['.'] !== main) fail('PACKAGE_EXPORTS', 'root package exports must expose the observer entry')
  if ('scripts' in pkg || 'dependencies' in pkg || 'devDependencies' in pkg) fail('PACKAGE_SIDE_EFFECTS', 'root package must not declare scripts or dependencies')
}

function listFiles (root) {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isSymbolicLink()) fail('ENVELOPE_LINK', 'envelope contains a link: ' + rel)
      if (entry.isDirectory()) walk(join(dir, entry.name), rel)
      else out.push(canonical(rel))
    }
  }
  walk(root, '')
  return out
}

function verifyFreshCheckout (repo, base, manifest) {
  const fresh = mkdtempSync(join(tmpdir(), 'tla-m1b-fresh-'))
  let added = false
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', fresh, base], { stdio: ['ignore', 'pipe', 'pipe'] })
    added = true
    for (const entry of manifest.files) {
      const freshPath = join(fresh, entry.source)
      if (!existsSync(freshPath)) fail('FRESH_CHECKOUT', 'fresh checkout is missing ' + entry.source)
      const bytes = readFileSync(freshPath)
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail('FRESH_CHECKOUT', 'fresh checkout differs from manifest: ' + entry.source)
    }
  } catch (error) {
    if (error instanceof PackageError) throw error
    fail('FRESH_CHECKOUT', 'fresh checkout could not be verified: ' + String(error.message))
  } finally {
    if (added) execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', fresh], { stdio: ['ignore', 'pipe', 'pipe'] })
    rmSync(fresh, { recursive: true, force: true })
  }
}

function verifyArchive (repo, base, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'tla-m1b-archive-'))
  const tar = join(dir, 'source.tar')
  try {
    const paths = manifest.files.map((entry) => entry.source)
    execFileSync('git', ['-C', repo, 'archive', '--format=tar', '--output=' + tar, base, '--', ...paths], { stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('tar', ['-xf', tar, '-C', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
    for (const entry of manifest.files) {
      const archived = join(dir, entry.source)
      if (!existsSync(archived)) fail('ARCHIVE', 'archive is missing ' + entry.source)
      const bytes = readFileSync(archived)
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail('ARCHIVE', 'archive differs from manifest: ' + entry.source)
    }
  } catch (error) {
    if (error instanceof PackageError) throw error
    fail('ARCHIVE', 'archive could not be verified: ' + String(error.message))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function checkM1BPackage (options = {}) {
  const repo = resolve(options.repo ?? process.cwd())
  const manifest = loadManifest(repo)
  const base = manifest.sourceBase
  const parsedBase = git(repo, ['rev-parse', base]).trim()
  if (!/^[0-9a-f]{40}$/u.test(parsedBase)) fail('SOURCE_BASE', 'sourceBase is not a commit')
  for (const entry of manifest.files) verifyEntrySource(repo, base, entry)
  verifyFreshCheckout(repo, base, manifest)
  verifyArchive(repo, base, manifest)

  const out = options.out === undefined
    ? mkdtempSync(join(tmpdir(), 'tla-m1b-envelope-'))
    : resolve(options.out)
  const created = options.out === undefined
  if (!created) {
    try {
      mkdirSync(dirname(out), { recursive: true })
      mkdirSync(out, { recursive: false })
    } catch (error) {
      fail('OUTPUT_EXISTS', 'envelope output must be fresh: ' + String(error.message))
    }
  }
  try {
    for (const entry of manifest.files) {
      if (typeof entry.path !== 'string' || entry.path === '' || isAbsolute(entry.path) || entry.path.split('/').includes('..')) {
        fail('DESTINATION_PATH', 'invalid envelope destination: ' + String(entry.path))
      }
      const target = join(out, entry.path)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(repo, entry.source), target)
    }
    const actual = listFiles(out)
    const expected = manifest.files.map((entry) => canonical(entry.path)).sort()
    if (actual.length !== 12 || actual.some((path, index) => path !== expected[index])) {
      fail('ENVELOPE_FILES', 'envelope does not contain exactly the 12 manifest paths')
    }
    checkPackageJson(join(out, 'package.json'))
    const fingerprint = fingerprintPluginDir(out)
    if (!fingerprint.ok) fail('ENVELOPE_FINGERPRINT', 'envelope fingerprint is not readable')
    if (fingerprint.fileCount !== 12 || fingerprint.buildDigest !== ENVELOPE_DIGEST) {
      fail('ENVELOPE_FINGERPRINT', 'envelope fingerprint does not match the reviewed 12-file digest')
    }
    const entry = pathToFileURL(join(out, 'orchestration', 'tool-observer', 'host-plugin', 'index.js')).href
    const imported = awaitImport(entry)
    if (typeof imported.createLoaderPlugin !== 'function') fail('ENVELOPE_IMPORT', 'observer entry does not export createLoaderPlugin')
    return {
      ok: true,
      fileCount: actual.length,
      digest: fingerprint.buildDigest,
      version: fingerprint.version,
      entry: manifest.envelope.entry,
      out
    }
  } finally {
    if (created) rmSync(out, { recursive: true, force: true })
  }
}

function awaitImport (href) {
  // The checker is synchronous except for this one no-side-effect module load.
  const { spawnSync } = process.getBuiltinModule('node:child_process')
  const code = 'import(' + JSON.stringify(href) + ').then(m=>{if(typeof m.createLoaderPlugin!=="function")process.exit(3)}).catch(e=>{console.error(String(e&&e.message||e));process.exit(4)})'
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  if (result.status !== 0) fail('ENVELOPE_IMPORT', 'observer entry could not be imported: ' + String(result.stderr || result.stdout))
  return { createLoaderPlugin: () => {} }
}

function parseCli (argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') {
      index += 1
      if (argv[index] === undefined) throw new PackageError('CLI', '--repo requires a value')
      options.repo = argv[index]
    } else if (arg === '--out') {
      index += 1
      if (argv[index] === undefined) throw new PackageError('CLI', '--out requires a value')
      options.out = argv[index]
    } else {
      throw new PackageError('CLI', 'unknown argument: ' + arg)
    }
  }
  return options
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = checkM1BPackage(parseCli(process.argv.slice(2)))
    process.stdout.write('M1B ENVELOPE OK (' + result.fileCount + ' files, ' + result.digest.slice(0, 12) + ')\n')
  } catch (error) {
    process.stderr.write('M1B ENVELOPE FAILED: ' + String(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  }
}
