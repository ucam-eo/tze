import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { ortWasmPlugin } from '@ucam-eo/tessera-tasks/vite';

export default defineConfig({
  base: './',
  plugins: [svelte(), tailwindcss(), ortWasmPlugin()],
  server: {
    proxy: {
      '/zarr': 'http://localhost:9999',
    },
  },
  resolve: {
    alias: {
      '@ucam-eo/maplibre-zarr-tessera': path.resolve(
        __dirname, '../../packages/maplibre-zarr-tessera/src/index.ts'
      ),
      '@ucam-eo/tessera-tasks': path.resolve(
        __dirname, '../../packages/tessera-tasks/src/index.ts'
      ),
    },
  },
});
