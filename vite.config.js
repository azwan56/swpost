import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // In production, set VITE_BASE_PATH=/swpost/ for subpath deployment
  base: process.env.FIGMA_PUBLIC_URL || process.env.VITE_BASE_PATH || '/',
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    ...(process.env.FIGMA ? {
      port: Number(process.env.PORT) || 5173,
      host: process.env.FIGMA_DEV_SERVER_HOST || '0.0.0.0',
      strictPort: true,
    } : {}),
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        secure: false
      }
    }
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
})
