/**
 * Installs the runtime dependencies if, and only if, they are missing.
 *
 * WHY THIS RUNS AT ALL. A Cloudflare Workers Build clones the repo and runs
 * the deploy command (`npx wrangler versions upload`) with no `npm install`
 * in front of it unless one is configured in the dashboard. Wrangler then
 * bundles `src/index.ts`, whose imports resolve to nothing, and the build
 * fails on a missing entry point's dependencies rather than on anything
 * wrong with the code. Wiring this into wrangler's own `build.command`
 * keeps the deploy self-sufficient: whatever runs `wrangler`, the deps are
 * there first.
 *
 * WHY THE GUARD. The same hook runs before `wrangler dev` and `wrangler
 * deploy` on a laptop, where `npm ci` would delete a perfectly good
 * node_modules (devDependencies included) and reinstall it every time. So
 * this checks first and, in the normal case, does nothing at all.
 *
 * Dev dependencies are deliberately NOT installed here: the MCP App bundle
 * is committed (see .gitignore), so a deploy needs no Vite, no Vitest and
 * certainly no browser download.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

/** Every runtime import in src/ has to resolve, not just one of them. */
const RUNTIME_DEPS = ['@modelcontextprotocol/server', '@modelcontextprotocol/ext-apps/server', 'agents/mcp/server', 'zod'];

function missing() {
  return RUNTIME_DEPS.filter((name) => {
    try {
      require.resolve(name, { paths: [root] });
      return false;
    } catch {
      return true;
    }
  });
}

const gaps = missing();
if (gaps.length === 0) {
  process.exit(0);
}

console.log(`[taskdag] installing runtime dependencies (missing: ${gaps.join(', ')})`);
const command = existsSync(new URL('../package-lock.json', import.meta.url)) ? 'ci' : 'install';
execFileSync('npm', [command, '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });

const stillMissing = missing();
if (stillMissing.length > 0) {
  console.error(`[taskdag] still missing after install: ${stillMissing.join(', ')}`);
  process.exit(1);
}
