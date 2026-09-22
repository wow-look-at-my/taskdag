/**
 * The capability URL's token rules.
 *
 * The token in `/:token/mcp` IS the login: knowing it is full read/write on
 * that graph, so the only tokens the server will answer to are ones with a
 * browser's 32 bytes of `crypto.getRandomValues` behind them. The server
 * never mints one (see the landing page) and never stores a list of them —
 * it only decides whether a path segment is shaped like real entropy.
 */

/** Length of base64url-encoded 32 random bytes, unpadded. */
const TOKEN_LENGTH = 43;

/**
 * Distinct characters a real 32-byte token has with overwhelming
 * probability. It is here to throw out hand-typed strings ("aaaa…",
 * "0000…") that happen to be the right length, not to add security.
 */
const MIN_DISTINCT_CHARS = 16;

/**
 * True for the only strings this server will treat as an owner id.
 *
 * Deliberately narrow: no hex ids, no UUIDs, no user-chosen slugs. `test`
 * and `foobar` never match the length, so they fall out on the first test.
 */
export function isOwnerToken(s: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return false; // 32 bytes b64url
  if (new Set(s).size < MIN_DISTINCT_CHARS) return false; // rejects "aaaa…"
  return true;
}

export { TOKEN_LENGTH, MIN_DISTINCT_CHARS };

/**
 * The last four characters of a token, for `taskdag://me`. Everything else
 * about the token stays out of tool results, resources and the App.
 */
export function tokenTail(token: string): string {
  return token.slice(-4);
}
