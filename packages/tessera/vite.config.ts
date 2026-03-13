import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { exec } from 'child_process';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'Tessera',
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rolldownOptions: {
      external: ['proj4', 'zarrita', '@zarrita/storage'],
    },
  },
  plugins: [
    dts(),
    {
      name: 'typedoc-on-build',
      closeBundle() {
        exec('typedoc', (err) => {
          if (err) console.warn('[typedoc]', err.message);
        });
      },
    },
  ],
});
