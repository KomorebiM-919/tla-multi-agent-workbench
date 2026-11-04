// 注册 electron → 测试替身的解析钩子（仅测试进程使用）。
import { register } from 'node:module'

register('./electron-loader-hooks.mjs', import.meta.url)
