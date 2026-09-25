import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  use: { baseURL: 'http://127.0.0.1:8765', browserName: 'chromium' },
  webServer: {
    command:
      'bash -c "source ../backend/dev.env && FPGAWEB_STATIC_DIR=$PWD/dist ../backend/.venv/bin/uvicorn fpgaweb.main:app --app-dir ../backend --port 8765"',
    url: 'http://127.0.0.1:8765/api/boards',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
