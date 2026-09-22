import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * `.sql` and `.html` imports are text, matching wrangler's Text rule (see
 * wrangler.jsonc). Without this the schema module cannot be imported under
 * vitest, and the migration would go untested exactly where it matters; the
 * `.html` half is what lets a test import `src/index.ts`, which pulls in the
 * landing page and the compiled App bundle the same way the Worker does.
 */
function textModules(): Plugin {
  return {
    name: 'taskdag:text-modules',
    enforce: 'pre',
    load(id) {
      const [path] = id.split('?');
      if (!path.endsWith('.sql') && !path.endsWith('.html')) return null;
      return `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`;
    },
  };
}

export default defineConfig({
  plugins: [textModules()],
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
});
