// 窗口与 IPC 的信任判定。
//
// 这里只放纯函数，便于脱离 Electron 单元测试：主进程把 frame、webContents 和目标
// 页面地址传进来，由本模块回答“这个调用方是不是我们自己那个窗口里的应用页面”。
// 判定必须绑定到具体窗口与 frame，而不是“URL 以 file:// 开头”这种宽泛前缀。

/** 把 URL 规范化成可直接比较的形式；非法 URL 返回 null。 */
export function canonicalUrl(url) {
  if (typeof url !== 'string' || url === '') return null
  try {
    return new URL(url).href
  } catch {
    return null
  }
}

/** 应用允许停留的页面：生产环境是打包内的 index.html，开发环境是本地 dev server。 */
export function isAllowedPage(url, { appUrl, devUrl = '' }) {
  const target = canonicalUrl(url)
  if (!target) return false
  if (target === canonicalUrl(appUrl)) return true
  if (!devUrl) return false
  const dev = canonicalUrl(devUrl)
  if (!dev) return false
  const trimmedDev = devUrl.replace(/\/+$/, '')
  return target === dev || target === canonicalUrl(`${trimmedDev}/`)
}

/**
 * 只信任“本窗口 webContents 的主 frame，且当前页面正是应用页面”的 IPC 调用方。
 * 子 frame、其他窗口、以及被导航到别处的页面一律拒绝。
 */
export function isTrustedSender({ frame, sender, windowWebContents, appUrl, devUrl = '' }) {
  if (!frame || !sender || !windowWebContents) return false
  if (sender !== windowWebContents) return false
  if (frame.parent !== null && frame.parent !== undefined) return false
  return isAllowedPage(frame.url, { appUrl, devUrl })
}
