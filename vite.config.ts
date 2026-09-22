/**
 * Builds the MCP App into ONE self-contained HTML file.
 *
 * Why single-file: the App iframe has no network by default (and TaskDAG
 * asks for none), so every byte the board needs — the `<dag-view>` element
 * out of the pinned submodule, its stylesheet, the App bridge — has to be
 * inside the resource body. Nothing is fetched from a CDN or from GitHub at
 * runtime; `wrangler deploy` ships the compiled bundle.
 */

import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * js-snippets components import their stylesheet as a STRING and adopt it
 * into a shadow root (`import dagCss from './dag-view.css'`). Vite would
 * otherwise treat that as a page stylesheet and inject it into the document,
 * where it would style nothing. This is esbuild's `text` loader, which is
 * what that repo builds with.
 */
function cssAsText(): Plugin {
  return {
    name: 'taskdag:css-as-text',
    enforce: 'pre',
    /**
     * Rewrites the submodule's `import css from './x.css'` to Vite's
     * `?inline` form, whose default export is the stylesheet as a string —
     * which is what the component adopts into its shadow root. Without this
     * the import resolves to Vite's page-stylesheet module, which has no
     * default export at all.
     */
    resolveId(source, importer) {
      if (!source.endsWith('.css') || !importer || !importer.includes('js-snippets')) return null;
      return `${resolve(dirname(importer), source)}?inline`;
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./web/widgets', import.meta.url)),
  plugins: [cssAsText(), viteSingleFile()],
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
    // One chunk, no code-splitting: a single file cannot load a second one.
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: fileURLToPath(new URL('./web/widgets/board.html', import.meta.url)),
    },
  },
});
