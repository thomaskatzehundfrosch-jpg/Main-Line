import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    proxy: {
      '/chess-api': {
        target: 'https://api.chess.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/chess-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader(
              'User-Agent',
              'Mozilla/5.0 (compatible; chess-repertoire-dev/1.0)'
            );
          });
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['stockfish'],
  },
});
