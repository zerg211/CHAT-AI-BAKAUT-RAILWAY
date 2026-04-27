import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3010',
      '/embed.js': 'http://localhost:3010',
      '/widget': 'http://localhost:3010'
    }
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true
  }
});
