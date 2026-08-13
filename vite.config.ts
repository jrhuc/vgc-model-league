import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const staticSite = mode === 'static';
  const clientModule = (name: string) => fileURLToPath(new URL(`./src/gui/client/${name}`, import.meta.url));
  return {
    root: 'src/gui/client',
    base: './',
    plugins: [preact()],
    resolve: {
      alias: staticSite
        ? [
            {
              find: /^\.\/capabilities\.js$/,
              replacement: clientModule('capabilities-static.ts'),
            },
            {
              find: /^\.\/operational-loader\.js$/,
              replacement: clientModule('operational-loader-static.tsx'),
            },
          ]
        : [],
    },
    build: {
      outDir: staticSite ? '../../../dist/gui-static' : '../../../dist/gui',
      emptyOutDir: true,
    },
  };
});
