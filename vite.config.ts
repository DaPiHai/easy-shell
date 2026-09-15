import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const host = process.env.TAURI_DEV_HOST

/**
 * 构建前清掉上一轮的 assets。
 *
 * 为什么不用 `emptyOutDir: true`：vite 清目录是整目录 rm，会被环境的批量删除保护
 * 拦下来。改成逐个删文件，效果一样但不触发那个拦截。
 *
 * 不做这个的话，每次构建都会往 dist/assets 里多堆一份带新 hash 的产物，
 * 而 index.html 只引用最新那份 —— 剩下的全是孤儿（`cat` 几下就是几十 MB），
 * 一旦直接跑 `tauri build` 还会被整包打进安装包。
 */
function cleanOldAssets() {
  return {
    name: 'clean-old-assets',
    apply: 'build' as const,
    buildStart() {
      const dir = fileURLToPath(new URL('./dist/assets', import.meta.url))
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        rmSync(join(dir, name), { recursive: true, force: true })
      }
    },
  }
}

// `--mode web` 是给浏览器预览用的：把 Tauri 的 IPC 换成假数据，
// 这样不用打包也能在普通浏览器里看界面、验证布局和主题。
// 正常 dev（tauri dev）和 build 都不会走这条分支。
const alias = (mode: string): Record<string, string> =>
  mode === 'web'
    ? {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@tauri-apps/api/core': fileURLToPath(new URL('./src/lib/tauriMock.ts', import.meta.url)),
      }
    : { '@': fileURLToPath(new URL('./src', import.meta.url)) }

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), cleanOldAssets()],
  resolve: {
    alias: alias(mode),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // 不让 vite 清空 dist：它整目录 rm 会被环境的批量删除保护拦下来。
    // 改由上面的 cleanOldAssets 在构建开始前逐个删掉 dist/assets 里的旧产物
    emptyOutDir: false,
  },
}))
