import { defineConfig } from 'vitest/config';

// Tier 1 (see ~/.claude/rules/testing.md): no network, no running server. Auth
// tests run against a real libSQL file in a temp directory, not a mock, so
// they exercise the same SQL the app runs. Only the Resend HTTP boundary is
// mocked.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Each auth test builds a Better Auth instance and migrates a fresh
    // database, which is slower than a unit test.
    testTimeout: 30_000,
  },
});
