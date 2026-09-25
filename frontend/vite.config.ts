import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['@yowasp/openfpgaloader'] },
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/*.test.ts'] },
});
