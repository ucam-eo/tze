import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'MaplibreZarrTessera',
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rolldownOptions: {
      external: ['maplibre-gl'],
    },
  },
});
