import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import { cpSync, mkdirSync } from 'node:fs'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

const BACKEND_SCHEMA = path.join(__dirname, '..', 'backend', 'src', 'main', 'persistence', 'schema.sql')
const DIST_ELECTRON = path.join(__dirname, 'dist-electron')

// backend's db.ts (findSchemaPath) looks for schema.sql next to the running main
// bundle first. The backend tree is read-only from here, so copy that one file into
// dist-electron on every main build / dev start. Output stays inside electron_app/.
function copyBackendSchema(): Plugin {
  return {
    name: 'copy-backend-schema-sql',
    buildStart() {
      mkdirSync(DIST_ELECTRON, { recursive: true })
      cpSync(BACKEND_SCHEMA, path.join(DIST_ELECTRON, 'schema.sql'))
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of build.lib.entry.
        entry: 'electron/main.ts',
        vite: {
          plugins: [copyBackendSchema()],
          build: {
            rollupOptions: {
              // Native module: must stay external (it resolves at runtime from
              // electron_app/node_modules, rebuilt for Electron via postinstall).
              // Everything else from backend/ (zod, pure TS) bundles inline.
              external: ['better-sqlite3'],
            },
          },
        },
      },
      preload: {
        // Shortcut of build.rollupOptions.input.
        // Preload scripts may contain Web assets, so use the build.rollupOptions.input instead build.lib.entry.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the nodeIntegration needs to be enabled in the Main process.
      // See https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
})
