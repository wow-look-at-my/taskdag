import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * `.sql` imports are text, matching wrangler's Text rule (see
 * wrangler.jsonc). Without this the schema module cannot be imported under
 * vitest, and the migration would go untested exactly where it matters.
 */
function sqlAsText(): Plugin {
  return {
    name: 'taskdag:sql-as-text',
    enforce: 'pre',
    load(id) {
      const [path] = id.split('?');
      if (!path.endsWith('.sql')) return null;
      return `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`;
    },
  };
}

export default defineConfig({
  plugins: [sqlAsText()],
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
});
