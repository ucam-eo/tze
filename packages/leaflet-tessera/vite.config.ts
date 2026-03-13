import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'LeafletTessera',
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rolldownOptions: {
      external: ['leaflet', '@ucam-eo/tessera'],
    },
  },
});
