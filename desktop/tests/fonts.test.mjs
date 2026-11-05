import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const fontSourceDir = path.join(desktopRoot, 'src', 'assets', 'fonts')
const licenseDir = path.join(desktopRoot, 'public', 'licenses', 'fonts')
const manifestPath = path.join(licenseDir, 'font-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function fontEntries() {
  return manifest.assets.filter((asset) => asset.family !== 'license')
}

function licenseEntries() {
  return manifest.assets.filter((asset) => asset.family === 'license')
}

test('内置字体清单只包含三份 WOFF2 与三份 OFL 许可，且字节数自洽', () => {
  assert.equal(fontEntries().length, 3)
  assert.equal(licenseEntries().length, 3)
  for (const asset of manifest.assets) {
    assert.ok(asset.bytes > 0, asset.file)
    assert.match(asset.sha256, /^[0-9a-f]{64}$/)
    assert.equal(asset.license, 'SIL OFL 1.1')
  }
  const total = fontEntries().reduce((sum, asset) => sum + asset.bytes, 0)
  assert.equal(total, manifest.totalFontBytes)
  assert.equal(total, 8311276)
})

test('源码内的字体与许可逐字节匹配清单，未被转码或替换', () => {
  for (const asset of fontEntries()) {
    const filePath = path.join(fontSourceDir, asset.file)
    assert.ok(existsSync(filePath), `缺少字体 ${asset.file}`)
    assert.equal(statSync(filePath).size, asset.bytes, asset.file)
    assert.equal(sha256(filePath), asset.sha256, asset.file)
  }
  for (const asset of licenseEntries()) {
    const filePath = path.join(licenseDir, asset.file)
    assert.ok(existsSync(filePath), `缺少许可 ${asset.file}`)
    assert.equal(sha256(filePath), asset.sha256, asset.file)
  }
})

test('样式只从本地 assets/fonts 加载字体，并声明正确的变量字重范围', () => {
  const css = readFileSync(path.join(desktopRoot, 'src', 'styles.css'), 'utf8')
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/i)
  for (const asset of fontEntries()) {
    assert.match(css, new RegExp(`url\\('\\./assets/fonts/${asset.file}'\\)`))
  }
  assert.match(css, /font-family: 'Source Sans 3'[\s\S]*?font-weight: 200 900;/)
  assert.match(css, /font-family: 'Source Serif 4'[\s\S]*?font-weight: 200 900;/)
  assert.match(css, /font-family: 'Source Han Sans CN'[\s\S]*?font-weight: 250 900;/)
  assert.equal((css.match(/font-display: swap;/g) || []).length, 3)
  assert.match(css, /--font-ui: 'Source Sans 3', 'Source Han Sans CN'/)
})

test('渲染产物随构建带上三份字体与许可证，字节与清单一致', { skip: !existsSync(path.join(desktopRoot, 'renderer-dist', 'assets')) }, () => {
  const builtDir = path.join(desktopRoot, 'renderer-dist', 'assets')
  const builtNames = readdirSync(builtDir)
  for (const asset of fontEntries()) {
    const stem = asset.file.replace(/\.woff2$/, '')
    const matches = builtNames.filter((name) => name.startsWith(`${stem}-`) && name.endsWith('.woff2'))
    assert.equal(matches.length, 1, `产物缺少 ${asset.file}`)
    const builtPath = path.join(builtDir, matches[0])
    assert.equal(statSync(builtPath).size, asset.bytes, asset.file)
    assert.equal(sha256(builtPath), asset.sha256, asset.file)
  }
  const builtLicenseDir = path.join(desktopRoot, 'renderer-dist', 'licenses', 'fonts')
  for (const asset of licenseEntries()) {
    const builtPath = path.join(builtLicenseDir, asset.file)
    assert.ok(existsSync(builtPath), `产物缺少许可 ${asset.file}`)
    assert.equal(sha256(builtPath), asset.sha256, asset.file)
  }
  const builtCss = readdirSync(builtDir).find((name) => name.endsWith('.css'))
  const css = readFileSync(path.join(builtDir, builtCss), 'utf8')
  for (const asset of fontEntries()) {
    const stem = asset.file.replace(/\.woff2$/, '')
    assert.match(css, new RegExp(`${stem}-[A-Za-z0-9_-]+\\.woff2`))
  }
})
