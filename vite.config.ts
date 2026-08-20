import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/gui/client',
  base: './',
  plugins: [preact()],
  build: {
    outDir: '../../../dist/gui',
    emptyOutDir: true,
  },
});
