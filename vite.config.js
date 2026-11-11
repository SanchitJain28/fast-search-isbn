import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { packingApiPlugin } from './server/api.js';
const root = fileURLToPath(new URL('.', import.meta.url));
const envKeys = ['PACKING_DB', 'SHEETS_SYNC_ENABLED', 'SHEETS_SPREADSHEET_ID', 'SHEETS_SCANNER_TAB', 'SHEETS_BATCH_SIZE', 'GOOGLE_APPLICATION_CREDENTIALS',
  'COVER_MATCH_ENABLED', 'COVER_MATCH_AUTO_PACK', 'COVER_VISION_PROVIDER', 'COVER_VISION_MODEL', 'GEMINI_API_KEY', 'COVER_MATCH_MIN_SCORE', 'COVER_MATCH_GAP_MIN', 'COVER_MATCH_AUTO_THRESHOLD',
  'COVER_VECTOR_SEARCH_ENABLED', 'COVER_VECTOR_PILOT_STATION', 'COVER_VECTOR_COLLECTION', 'COVER_VECTOR_REVIEW_COLLECTION', 'COVER_VECTOR_MIN_SCORE', 'COVER_VECTOR_MIN_GAP', 'QDRANT_URL', 'QDRANT_API_KEY'];
const reloadableEnvKeys = ['COVER_MATCH_ENABLED', 'COVER_MATCH_AUTO_PACK', 'COVER_VISION_PROVIDER', 'COVER_VISION_MODEL', 'GEMINI_API_KEY', 'COVER_MATCH_MIN_SCORE', 'COVER_MATCH_GAP_MIN', 'COVER_MATCH_AUTO_THRESHOLD',
  'COVER_VECTOR_SEARCH_ENABLED', 'COVER_VECTOR_PILOT_STATION', 'COVER_VECTOR_COLLECTION', 'COVER_VECTOR_REVIEW_COLLECTION', 'COVER_VECTOR_MIN_SCORE', 'COVER_VECTOR_MIN_GAP', 'QDRANT_URL', 'QDRANT_API_KEY'];
export default defineConfig(({ mode }) => {
  if (fs.existsSync(path.join(root, '.env.local'))) {
    for (const key of reloadableEnvKeys) delete process.env[key];
  }
  const env = loadEnv(mode, root, '');
  for (const key of envKeys) {
    if (process.env[key] == null && env[key] != null) process.env[key] = env[key];
  }
  return { plugins: [react(), packingApiPlugin(root)],
    // React and MUI must share one optimized React instance in development.
    resolve: { dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled'] },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@mui/material', '@mui/icons-material', '@mui/x-data-grid', '@emotion/react', '@emotion/styled'] },
    server: { host: true, port: 3000, strictPort: true,
      fs: { deny: ['**/.env*', '**/*.{crt,pem,key}', '**/.git/**', '**/credentials.json', '**/*.key.json', `${root}data/**`, ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? [process.env.GOOGLE_APPLICATION_CREDENTIALS] : [])] } },
    preview: { host: true, port: 3000, strictPort: true } };
});
