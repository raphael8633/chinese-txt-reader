import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/reader/',
  plugins: [
    react(),
    VitePWA({
      injectRegister: false,
      registerType: 'prompt',
      devOptions: { enabled: false },
      workbox: {
        navigateFallback: '/reader/index.html',
        navigateFallbackDenylist: [/^\/reader\/api\//],
      },
      manifest: {
        name: 'Raph Reader',
        short_name: 'Reader',
        theme_color: '#f5f0e8',
        icons: [],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/opencc-js')) {
            return 'opencc'
          }
          if (
            id.includes('node_modules/react-dom')
            || id.includes('node_modules/react-router')
            || id.includes('node_modules/react/')
          ) {
            return 'vendor'
          }
        },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/reader/api': {
        target: 'http://127.0.0.1:3005',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/reader\/api/, '/api'),
      },
      '/api': {
        target: 'http://127.0.0.1:3005',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5174,
    allowedHosts: (process.env.READER_ALLOWED_HOSTS ?? 'localhost').split(','),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
})
