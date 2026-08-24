import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { ortWasmPlugin } from '@ucam-eo/tessera-tasks/vite';

export default defineConfig({
  base: '/',
  plugins: [svelte(), tailwindcss(), ortWasmPlugin()],
  server: {
    // Pre-transform components at startup. Without this, the browser can ask
    // for a component's extracted style sub-module
    // (`Foo.svelte?svelte&type=style&lang.css`) before vite-plugin-svelte has
    // compiled its parent. Vite then falls back to reading the raw .svelte
    // file off disk and hands that to @tailwindcss/vite, which tries to parse
    // the <script> as CSS and dies with "Invalid declaration: `onMount`".
    warmup: {
      clientFiles: ['./src/**/*.svelte'],
    },
    proxy: {
      '/zarr': 'http://localhost:9999',
    },
  },
  resolve: {
    alias: {
      '@ucam-eo/maplibre-tessera': path.resolve(
        __dirname, '../../packages/maplibre-tessera/src/index.ts'
      ),
      '@ucam-eo/tessera-tasks/classify': path.resolve(
        __dirname, '../../packages/tessera-tasks/src/classify.ts'
      ),
      '@ucam-eo/tessera-tasks/segment': path.resolve(
        __dirname, '../../packages/tessera-tasks/src/segment.ts'
      ),
      '@ucam-eo/tessera-tasks': path.resolve(
        __dirname, '../../packages/tessera-tasks/src/index.ts'
      ),
    },
  },
});
