const KNOWN_PLACEHOLDERS = new Set([
  'test-key',
  'local-dev-placeholder',
  'testnet-placeholder-no-real-key',
]);

/** True only when the env var holds something other than a known dev placeholder. */
export function isRealApiKey(value: string | undefined): boolean {
  return Boolean(value) && !KNOWN_PLACEHOLDERS.has(value as string);
}
