import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// @yowasp/openfpgaloader's bundle.js spawns a pthread worker via
// `new Worker(new URL('openFPGALoader.mjs', import.meta.url))`, but the
// published package only ships `bundle.js` (esbuild's outfile) -- the
// `openFPGALoader.mjs` name is a leftover from its pre-bundle source, and
// that file does not exist in the package. Vite's worker-constructor
// analysis resolves that literal at build time and fails, so alias it to
// the file that actually ships.
const yowaspGen = fileURLToPath(new URL('./node_modules/@yowasp/openfpgaloader/gen/', import.meta.url));

export default defineConfig({
  optimizeDeps: { exclude: ['@yowasp/openfpgaloader'] },
  ssr: { external: ['@yowasp/openfpgaloader'] },
  resolve: { alias: [{ find: `${yowaspGen}openFPGALoader.mjs`, replacement: `${yowaspGen}bundle.js` }] },
  assetsInclude: ['**/*.wasm'],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/*.test.ts'] },
});
