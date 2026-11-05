// 构建产物冒烟测试：确认 renderer-dist 里真的产出了带 CSP 的页面和包含六个角色的脚本。
// 未构建时跳过（先跑 npm run build:renderer）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(here, '..', 'renderer-dist')
const indexPath = path.join(distDir, 'index.html')

const built = fs.existsSync(indexPath)

test('渲染层构建产物存在且带 CSP', { skip: built ? false : '先运行 npm run build:renderer' }, () => {
  const html = fs.readFileSync(indexPath, 'utf8')
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /default-src 'self'/)
  assert.match(html, /<div id="root">/)
  assert.doesNotMatch(html, /nodeIntegration/i)
})

test('脚本产物包含六个角色与“尚未连接模型”标记', { skip: built ? false : '先运行 npm run build:renderer' }, () => {
  const assetsDir = path.join(distDir, 'assets')
  const scripts = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.js'))
  assert.equal(scripts.length, 1, '预期只有一个入口脚本')

  const bundle = fs.readFileSync(path.join(assetsDir, scripts[0]), 'utf8')
  for (const name of [
    '用户总控制',
    'Codex 主管',
    'Kimi 需求理解',
    'DeepSeek 开发',
    'GLM 辅助',
    'MiMo 前端',
    '初始团队模板',
    '尚未连接模型',
    '任务草稿',
    '新建项目',
    '未保存',
    '保存失败',
    '发现未保存内容',
    '取消新建',
    '仍然关闭',
    '项目设置',
    '项目计划',
    '保存项目设置',
    '给团队的消息',
    '未发送文字',
    '输入已保留',
  ]) {
    assert.ok(bundle.includes(name), `构建产物缺少文案：${name}`)
  }
})
