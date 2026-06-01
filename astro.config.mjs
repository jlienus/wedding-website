import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://johnanddianaswedding.com',
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es'],
    routing: { prefixDefaultLocale: false }
  },
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
    assets: '_assets'
  },
  vite: {
    build: {
      minify: 'esbuild',
      sourcemap: false,
      cssMinify: 'esbuild'
    },
    esbuild: {
      legalComments: 'none'
    }
  }
});

