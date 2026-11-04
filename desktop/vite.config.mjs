import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 渲染层单独构建到 renderer-dist，再由 electron-builder 打进 asar。
// base 用相对路径，打包后用 file:// 加载才不会指向文件系统根目录。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'renderer-dist',
    emptyOutDir: true,
    // 桌面端只服务 Electron 45 内置的 Chromium，不需要为旧浏览器降级。
    target: 'chrome140',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
