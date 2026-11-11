import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base './' so the same build loads from file:// inside Electron and from any web path.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
