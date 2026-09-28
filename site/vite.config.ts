import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), play: resolve(__dirname, 'play/index.html') },
    },
  },
  server: { proxy: { '/api': { target: 'http://localhost:8799', ws: true } } },
});
