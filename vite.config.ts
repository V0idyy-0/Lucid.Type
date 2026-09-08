import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // relative paths so the production build loads over file:// inside Electron
  base: './',
  plugins: [
    react(),
    tailwindcss(),
  ],
})