/**
 * The four price sources.
 *
 * Carried forward from `repos/forge-pay/services/pay/src/pricing.ts:89` — the endpoints, the
 * Kraken legacy-asset-name mapping and the note about Binance quoting in USDT are all its work and
 * all correct. Three things change:
 *
 *   1. **A source yields decimal STRINGS, never numbers.** The old file returned
 *      `Partial<Record<MarketCoin, number>>` and converted with `Math.floor(usd * 1e6)`, so every
 *      quote had been through a double twice before the median saw it. See `rates.ts`.
 *   2. **Fetching is injected.** `marketSources` takes its transport, so the whole oracle can be
 *      driven from a fake in tests — no test in this repository touches a live exchange, which is
 *      what makes the divergence and staleness rules testable at all rather than aspirational.
 *   3. **A source's failure is its own.** `Promise.allSettled` in `oracle.ts` means one exchange
 *      being down costs one source, not the round.
 */

import type { AssetCode } from '@cloudsforge/contracts-chain'
import { MARKET_ASSETS } from './rates.ts'

/** Decimal strings, keyed by asset. Absent means this source did not quote that asset. */
export type SourceQuotes = Partial<Record<AssetCode, string>>

export interface PriceSource {
  readonly name: string
  fetch(): Promise<SourceQuotes>
}

/** The transport, injected. Returns parsed JSON or throws. */
export type FetchJson = (url: string) => Promise<unknown>

/**
 * A decimal string from a JSON field.
 *
 * A string field is used verbatim and is therefore exact. A JSON *number* has already been parsed
 * into a double by `JSON.parse` before this function can see it, so the loss — if any — happened
 * before us; `String()` renders the shortest decimal that round-trips that double, and `parseScaled`
 * then reads its digits exactly. What this avoids is the second, larger rounding the old oracle
 * added on top by multiplying that double by 1e6.
 *
 * Of the four sources only CoinGecko quotes as a number. That is a reason to prefer the other
 * three, not a reason to drop it: it is one of four inputs to a median.
 */
export function decimalFrom(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value)
  return undefined
}

/** Assign only the assets a source actually quoted, so an absent asset stays absent. */
function collect(entries: ReadonlyArray<readonly [AssetCode, string | undefined]>): SourceQuotes {
  const out: SourceQuotes = {}
  for (const [asset, value] of entries) {
    if (value !== undefined) out[asset] = value
  }
  return out
}

/**
 * The real transport. An absolute per-request deadline, because a hung exchange must not hold the
 * refresh lease open — the lease would expire mid-round and a second replica would start another.
 */
export function httpFetchJson(timeoutMs: number): FetchJson {
  return async (url: string) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`)
    return response.json()
  }
}

/**
 * Kraken answers under its own legacy asset names rather than the pair that was asked for.
 * Preserved from the old oracle, which discovered this the hard way.
 */
const KRAKEN_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  BTC: ['XXBTZUSD', 'XBTUSD'],
  ETH: ['XETHZUSD', 'ETHUSD'],
  SOL: ['SOLUSD'],
  XRP: ['XXRPZUSD', 'XRPUSD'],
})

const COINGECKO_IDS: Readonly<Record<string, string>> = Object.freeze({
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
})

export function marketSources(fetchJson: FetchJson): PriceSource[] {
  return [
    {
      name: 'coingecko',
      fetch: async () => {
        const data = (await fetchJson(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple&vs_currencies=usd',
        )) as Record<string, { usd?: unknown } | undefined>
        return collect(
          MARKET_ASSETS.map((asset) => {
            const id = COINGECKO_IDS[asset]
            return [asset, id ? decimalFrom(data[id]?.usd) : undefined] as const
          }),
        )
      },
    },

    {
      name: 'coinbase',
      fetch: async () => {
        // One request per asset, in parallel. A single asset's request failing rejects this
        // source's whole promise, which is correct: a partial answer from one venue is still one
        // opinion, and the round's minimum-source rule is what decides whether losing it matters.
        const results = await Promise.all(
          MARKET_ASSETS.map(async (asset) => {
            const data = (await fetchJson(`https://api.coinbase.com/v2/prices/${asset}-USD/spot`)) as {
              data?: { amount?: unknown }
            }
            return [asset, decimalFrom(data.data?.amount)] as const
          }),
        )
        return collect(results)
      },
    },

    {
      name: 'kraken',
      fetch: async () => {
        const data = (await fetchJson(
          'https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,XRPUSD',
        )) as { result?: Record<string, { c?: unknown[] } | undefined> }
        const result = data.result ?? {}
        return collect(
          MARKET_ASSETS.map((asset) => {
            const hit = (KRAKEN_KEYS[asset] ?? []).map((key) => result[key]).find(Boolean)
            return [asset, decimalFrom(hit?.c?.[0])] as const
          }),
        )
      },
    },

    {
      name: 'binance',
      fetch: async () => {
        // Quoted in USDT, not USD. A depeg shows up as divergence against the other three and
        // takes the whole round out rather than skewing the median — which is the behaviour we
        // want, and the reason the divergence check is a rejection rather than an outlier trim.
        const data = (await fetchJson(
          'https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22SOLUSDT%22,%22XRPUSDT%22%5D',
        )) as Array<{ symbol?: string; price?: unknown }>
        const rows = Array.isArray(data) ? data : []
        return collect(
          MARKET_ASSETS.map((asset) => {
            const row = rows.find((r) => r.symbol === `${asset}USDT`)
            return [asset, decimalFrom(row?.price)] as const
          }),
        )
      },
    },
  ]
}
