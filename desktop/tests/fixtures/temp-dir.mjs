// 测试用临时目录：固定在仓库内 desktop/tests/.tmp（已加入 .gitignore），
// 目录名用普通 UUID，避免受限会话下系统临时目录的权限差异。
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const TEMP_ROOT = path.join(here, '..', '.tmp')

export async function makeTempDir() {
  const directory = path.join(TEMP_ROOT, randomUUID())
  await mkdir(directory, { recursive: true })
  return directory
}

export async function removeTempDir(directory) {
  await rm(directory, { recursive: true, force: true })
}
