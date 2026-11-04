import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalUrl, isAllowedPage, isTrustedSender } from '../electron/security.mjs'

const APP_URL = 'file:///C:/app/resources/app.asar/renderer-dist/index.html'
const DEV_URL = 'http://127.0.0.1:5173'

function fakeFrame(url, parent = null) {
  return { url, parent }
}

test('canonicalUrl 规范化合法地址并拒绝非法输入', () => {
  assert.equal(canonicalUrl(APP_URL), APP_URL)
  assert.equal(canonicalUrl(''), null)
  assert.equal(canonicalUrl('not a url'), null)
  assert.equal(canonicalUrl(undefined), null)
})

test('只允许停留在应用页面本身', () => {
  assert.equal(isAllowedPage(APP_URL, { appUrl: APP_URL }), true)
  assert.equal(isAllowedPage(`${APP_URL}#team`, { appUrl: APP_URL }), false)
  assert.equal(isAllowedPage('file:///C:/app/resources/app.asar/renderer-dist/other.html', { appUrl: APP_URL }), false)
  assert.equal(isAllowedPage('https://example.com', { appUrl: APP_URL }), false)
  assert.equal(isAllowedPage('about:blank', { appUrl: APP_URL }), false)
})

test('开发服务器地址按完整地址比对，不做前缀放行', () => {
  assert.equal(isAllowedPage(DEV_URL, { appUrl: APP_URL, devUrl: DEV_URL }), true)
  assert.equal(isAllowedPage(`${DEV_URL}/`, { appUrl: APP_URL, devUrl: DEV_URL }), true)
  assert.equal(isAllowedPage(`${DEV_URL}/evil`, { appUrl: APP_URL, devUrl: DEV_URL }), false)
  assert.equal(isAllowedPage('http://127.0.0.1:5173.evil.com/', { appUrl: APP_URL, devUrl: DEV_URL }), false)
})

test('IPC 只信任本窗口主 frame 的应用页面', () => {
  const windowWebContents = { id: 1 }

  assert.equal(
    isTrustedSender({
      frame: fakeFrame(APP_URL),
      sender: windowWebContents,
      windowWebContents,
      appUrl: APP_URL,
    }),
    true,
  )

  // 子 frame 一律拒绝，即使 URL 相同。
  assert.equal(
    isTrustedSender({
      frame: fakeFrame(APP_URL, { url: APP_URL }),
      sender: windowWebContents,
      windowWebContents,
      appUrl: APP_URL,
    }),
    false,
  )

  // 其他 webContents 一律拒绝。
  assert.equal(
    isTrustedSender({
      frame: fakeFrame(APP_URL),
      sender: { id: 2 },
      windowWebContents,
      appUrl: APP_URL,
    }),
    false,
  )

  // 被导航到外部页面后不再可信。
  assert.equal(
    isTrustedSender({
      frame: fakeFrame('https://example.com/'),
      sender: windowWebContents,
      windowWebContents,
      appUrl: APP_URL,
    }),
    false,
  )

  assert.equal(
    isTrustedSender({
      frame: null,
      sender: windowWebContents,
      windowWebContents,
      appUrl: APP_URL,
    }),
    false,
  )

  // 窗口尚未创建时不存在“本窗口”，必须拒绝。
  assert.equal(
    isTrustedSender({
      frame: fakeFrame(APP_URL),
      sender: windowWebContents,
      windowWebContents: undefined,
      appUrl: APP_URL,
    }),
    false,
  )
})
