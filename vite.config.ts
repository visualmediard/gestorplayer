import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'child_process'
import { watch as fsWatch } from 'fs'
import { resolve } from 'path'

function syncAndroidPlugin() {
  const script = resolve(__dirname, 'scripts/sync-player-android.cjs')
  const player = resolve(__dirname, 'player/index.html')

  function sync() {
    try {
      execFileSync('node', [script], { stdio: 'inherit' })
    } catch (e: any) {
      console.error('[sync-android]', e.message)
    }
  }

  return {
    name: 'sync-android',
    buildStart() { sync() },
    configureServer(server: any) {
      const watcher = fsWatch(player, sync)
      server.httpServer?.on('close', () => watcher.close())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), syncAndroidPlugin()],
})
