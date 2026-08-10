import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  root: 'src/gui/client',
  base: './',
  plugins: [preact()],
  define: { __STATIC_SITE__: JSON.stringify(mode === 'static') },
  build: {
    outDir: mode === 'static' ? '../../../dist/gui-static' : '../../../dist/gui',
    emptyOutDir: true,
  },
}));
