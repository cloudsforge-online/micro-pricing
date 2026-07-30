import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checksumOf } from '@cloudsforge/db'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'

const sql = MIGRATIONS.map((m) => m.up).join('\n')

/**
 * The DDL with `--` comments removed.
 *
 * Assertions that a migration does *not* contain something must run against the statements, not
 * the prose: these migrations explain their reasoning at length, and a comment about why a column
 * is not a float contains the word "float".
 */
const statementsOf = (text: string): string => text.replace(/--[^\n]*/g, '')

test('versions are unique and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length, 'a duplicate version makes the run refuse')
})

test('SCHEMA_VERSION is the highest migration, so a new one raises the boot assertion', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('a new service baselines nothing', () => {
  assert.equal(BASELINE_VERSION, 0, 'a non-zero baseline records migrations as applied without running them')
})

test('no migration interpolates anything into its SQL', () => {
  // The `up` strings are template literals. A stray substitution would ship DDL nobody wrote — and
  // because the checksum is taken over the substituted text, two environments could disagree about
  // what a migration even says.
  for (const m of MIGRATIONS) {
    assert.doesNotMatch(m.up, /\$\{/, `${m.name} interpolates into its SQL`)
  }
})

test('checksums are whitespace-insensitive at the edges, and nowhere else', () => {
  for (const m of MIGRATIONS) {
    assert.equal(checksumOf(m), checksumOf({ ...m, up: `\n  ${m.up}  \n` }), `${m.name} is whitespace-sensitive`)
    assert.notEqual(checksumOf(m), checksumOf({ ...m, up: `${m.up}\nselect 1;` }))
  }
})

test('every table the service reads or writes is created', () => {
  for (const table of [
    'jobs',
    'outbox',
    'event_subscriptions',
    'outbox_deliveries',
    'inbox',
    'price_quotes',
    'administered_prices',
    'price_history',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}\\b`), `${table} is missing`)
  }
})

test('THE FIX: the quote lives in a table, and its rate column is numeric', () => {
  // The whole service in one assertion. A Map cannot be shared between replicas; a table is.
  assert.match(statementsOf(sql), /create table if not exists price_quotes[\s\S]*?usd_scaled\s+numeric\(78,\s*0\)/)
})

test('a quote cannot be zero or negative, whatever writes it', () => {
  // In the constraint rather than the application, so a psql session obeys it too.
  assert.match(statementsOf(sql), /usd_scaled is null or usd_scaled > 0/)
  assert.match(statementsOf(sql), /administered_prices[\s\S]*?check \(usd_scaled > 0\)/)
})

test('the source column is a closed set, so a third kind cannot appear by accident', () => {
  // Both tables that carry a source: price_quotes and price_history. administered_prices has no
  // such column, because everything in it is administered by definition.
  const checks = statementsOf(sql).match(/check \(source in \('market', 'administered'\)\)/g) ?? []
  assert.equal(checks.length, 2, 'a source column is unconstrained')
})

test('EMBER is seeded, and the seed records that nobody has decided the price yet', () => {
  assert.match(sql, /insert into administered_prices \(asset, usd_scaled, set_by, set_by_handle\)/)
  // 250000 is 0.25 x RATE_SCALE as an integer literal — not an expression Postgres would evaluate
  // in floating point.
  assert.match(sql, /values \('EMBER', 250000, null, null\)/)
})
