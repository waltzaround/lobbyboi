import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The Worker (wrangler dev) serves the API and WebSockets.
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
});
