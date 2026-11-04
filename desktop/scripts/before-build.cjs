// electron-builder 的 beforeBuild 钩子。
//
// 本工程没有运行时依赖：渲染层已被 Vite 打进 renderer-dist，主进程只用 Electron
// 内置模块。返回 false 表示“node_modules 由外部处理”，electron-builder 因此跳过
// 依赖安装/重建与依赖树收集（它内部会执行 `npm ls`，在受限沙箱下会 spawn 失败）。
// 如果以后加入运行时依赖，必须删掉这个钩子，让 electron-builder 正常收集依赖。

module.exports = async function beforeBuild() {
  return false
}
