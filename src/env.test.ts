import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The
 * failure cases below go through `loadEnv`, which is pure over its source and therefore testable
 * without a child process.
 */
const VALID: Record<string, string> = {
  PRICING_DATABASE_URL: 'postgres://pricing:pw@127.0.0.1:5432/pricing',
  IDENTITY_JWKS_URL: 'http://identity.test/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://identity.test',
  OUTBOX_SIGNING_SECRET: 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4',
}
for (const [key, value] of Object.entries(VALID)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv } = await import('./env.ts')

const BASE = VALID

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, VALID['PRICING_DATABASE_URL'])
  assert.equal(SERVICE, 'pricing')
})

test('a missing variable names itself', () => {
  assert.throws(
    () => loadEnv({ ...BASE, PRICING_DATABASE_URL: undefined }),
    (err: unknown) => err instanceof EnvError && /PRICING_DATABASE_URL is required/.test(err.message),
  )
  assert.throws(() => loadEnv({ ...BASE, IDENTITY_ISSUER: undefined }), /IDENTITY_ISSUER is required/)
})

test('a placeholder secret is refused outright', () => {
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'changeme' }), /known placeholder/)
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }), /at least 24 characters/)
})

test('the oracle defaults are the safe ones', () => {
  const loaded = loadEnv(BASE)
  assert.equal(loaded.minSources, 2, 'one source is one exchange\'s opinion, not a median')
  assert.equal(loaded.maxDivergenceBps, 200)
  assert.equal(loaded.maxAgeSeconds, 300)
  assert.equal(loaded.conversionSpreadBps, 100)
  assert.equal(loaded.refreshSeconds, 60)
})

test('the spread can never reach 10000 bps, which would divide by zero on the buy leg', () => {
  // `applySpreadBuy` divides by (10000 - bps). The bound is set far below that anyway.
  assert.throws(() => loadEnv({ ...BASE, PRICING_CONVERSION_SPREAD_BPS: '10000' }), /between 0 and 2000/)
  assert.throws(() => loadEnv({ ...BASE, PRICING_CONVERSION_SPREAD_BPS: '-1' }), /between 0 and 2000/)
  assert.equal(loadEnv({ ...BASE, PRICING_CONVERSION_SPREAD_BPS: '0' }).conversionSpreadBps, 0)
})

test('the source minimum cannot exceed the number of sources that exist', () => {
  assert.throws(() => loadEnv({ ...BASE, PRICING_MIN_SOURCES: '5' }), /between 1 and 4/)
  assert.equal(loadEnv({ ...BASE, PRICING_MIN_SOURCES: '4' }).minSources, 4)
})

test('a maximum age of zero is refused: it would make every rate unusable the instant it landed', () => {
  assert.throws(() => loadEnv({ ...BASE, PRICING_MAX_AGE_SECONDS: '0' }), /between 5 and 86400/)
})

test('a non-integer setting is refused rather than coerced', () => {
  assert.throws(() => loadEnv({ ...BASE, PRICING_MAX_DIVERGENCE_BPS: '2.5' }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, PORT: 'four thousand' }), EnvError)
})

test('LOG_LEVEL is a closed set', () => {
  assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/)
})
