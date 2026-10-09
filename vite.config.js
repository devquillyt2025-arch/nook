// Trigger reload to copy updated favicon
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

try {
  const srcPath = path.resolve(__dirname, 'nook-favicon.png')
  const destPublicPath = path.resolve(__dirname, 'public', 'nook-favicon.png')
  const destSrcPath = path.resolve(__dirname, 'src', 'nook-favicon.png')
  
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPublicPath)
    fs.copyFileSync(srcPath, destSrcPath)
    console.log('Successfully copied favicon to public and src!')
  }
} catch (e) {
  console.error('Error copying favicon:', e)
}

export default defineConfig({
  plugins: [react()],
})
