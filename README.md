# micro-pricing

[![ci](https://github.com/cloudsforge-online/micro-pricing/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-pricing/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml)

The price oracle: four independent sources, a median in BigInt fixed point, divergence rejection,
fail-closed staleness, and administered prices for assets with no market. **Quotes live in a table,
not in a per-replica `Map`.**

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

> **There is not a floating-point operation on the money path, and a test greps the whole source
> tree to keep it that way** (`src/rates.ts:2-3`, `src/nofloat.test.ts`). Every decimal that
> crosses the wire is a string, in both directions, because a JSON number is an IEEE 754 double and
> a rate that travels as one has lost precision before the consumer parses it
> (`src/quotes.ts:355-358`).

It owns market sources, the median oracle, administered prices, spread policy, rate history and the
valuation arithmetic — valuation is served as the `shardsPerCoin*` fields of a rate rather than as a
route of its own (`src/quotes.ts:379-383`). It holds no balances, moves no money and settles
nothing: a conversion is somebody else's transaction, and this service is what it may price it at.

## The two defects this service was built to fix

Both are in the oracle it replaces, and both are named in the source with the line that shows them.

**1. The quotes lived in a `Map`, and a `Map` is per-process** (`src/migrations.ts:12-27`). With
more than one replica: each refreshed on its own `setInterval` and held its own median, so two
replicas quoted different rates for the same second and a user could shop between them;
`PUT /admin/prices/:asset` reached exactly one replica, so an administered EMBER price was applied
there and ignored everywhere else; and a restart emptied the Map, so a fresh replica served "no
quote yet" until its first round. A table makes the estate quote one rate, makes an admin change
atomic and estate-wide, and lets the refresh run **once under a lease** instead of N times
(`src/jobs.ts:7-11`).

**2. Every quote went through a double, twice** (`src/rates.ts:8-26`). The old conversion was
`BigInt(Math.floor(usd * Number(RATE_SCALE)))` — the exchange's decimal string rounded into a double
by `Number()`, then multiplied by 1e6, which can move the result a whole unit at the sixth decimal
place. The estate then took a median of those values and settled conversions against it. And the
rate was rendered back to clients with `Number(scaled) / Number(RATE_SCALE)`, round-tripping it
through a double on the way out as well.

`parseScaled` reads the decimal digits directly (`src/rates.ts:96-103`): `"0.512345"` produces
exactly `512345n` and `"64231.5"` produces exactly `64231500000n`. `formatScaled` renders back
without a float in either direction (`src/rates.ts:125-132`). `RATE_DECIMALS` is derived from
`RATE_SCALE` rather than written as `6`, so a coordinated change to the scale cannot leave this file
behind (`src/rates.ts:36-42`).

## How a round is decided

`src/rates.ts` is pure — no I/O, no environment, no clock — so every branch below is reachable in a
test without a network or a database, which is what makes the divergence rule something the suite
can pin down rather than a claim (`src/rates.ts:228-239`).

1. **Fetch all four sources with `Promise.allSettled`** (`src/oracle.ts:64-81`). One exchange being
   down costs one source, not the round, and it is logged at **warn** rather than error: one source
   failing is the condition this design exists to tolerate, and paging on it would page four times
   a week for nothing.
2. **Parse each quote.** A malformed field costs that source its vote on that asset and nothing
   more — but it is logged, because a source that has changed its response shape would otherwise
   quietly reduce every round to three sources for ever (`src/oracle.ts:91-98`).
3. **Require `minSources`** (default 2). Below it the outcome is `too_few_sources`
   (`src/rates.ts:244-251`).
4. **Reject on divergence.** `divergenceBps` is `(high − low) × 10000 / low`, measured against the
   **lowest** so the number answers the question an operator actually asks — how far apart are
   these — without depending on the statistic the round is about to compute (`src/rates.ts:158-171`).
   Past the threshold the **whole round is thrown out**: if two sources disagree by more than the
   limit, one of them is wrong and there is no way to tell which, so none of them is usable
   (`src/rates.ts:235-238`). Taking the median anyway would launder a bad print into a rate that
   money then settles against, and a median of four is not robust to two wrong sources.
5. **Take the median, not the mean** (`src/rates.ts:139-156`). A mean is moved by a single bad
   print and a median is not: with four sources, one exchange showing a flash crash shifts a mean
   by a quarter of the error and shifts the median by nothing. An even count averages the two
   middle values **in BigInt and rounds down** — picking the lower or the upper middle would make
   the rate depend on which of two equally valid sources happened to answer.

`refreshRound` **never throws for a price reason** (`src/oracle.ts:55-63`). A round in which every
source failed is a recorded failure per asset, not an exception: throwing would fail the leased job,
burn its attempt budget and eventually dead-letter the refresh, stopping the oracle entirely because
one exchange had a bad afternoon. It throws only if the database is unreachable, which is a fault
the runner's retry is the right answer to.

### The four sources

Endpoints, the Kraken legacy-name mapping and the Binance note are carried forward from the oracle
this replaces, which got them right (`src/sources.ts:1-16`).

| Source | Shape | Note |
| --- | --- | --- |
| CoinGecko | one request for all four assets | the **only** source that quotes as a JSON number, so its value has already been through a double before this code sees it. A reason to prefer the other three, not to drop it: it is one of four inputs to a median (`src/sources.ts:32-51`) |
| Coinbase | one request per asset, in parallel | any one failing rejects the whole source, which is correct — a partial answer from one venue is still one opinion, and the minimum-source rule decides whether losing it matters (`src/sources.ts:115-117`) |
| Kraken | one request, legacy keys | answers under `XXBTZUSD`/`XBTUSD` rather than the pair asked for (`src/sources.ts:77-86`) |
| Binance | one request | **quoted in USDT, not USD**. A depeg shows up as divergence against the other three and takes the round out rather than skewing the median — which is the behaviour wanted, and the reason divergence is a rejection rather than an outlier trim (`src/sources.ts:149-151`) |

The transport is injected (`src/sources.ts:29-30`, `src/sources.ts:66-75`), so **no test in this
repository touches a live exchange**. Each request carries an absolute deadline, because a hung
exchange must not hold the refresh lease open — the lease would expire mid-round and a second
replica would start another.

Market assets are derived as `ON_CHAIN_ASSETS` minus `ADMINISTERED_ASSETS` rather than listed again
(`src/rates.ts:44-65`): a second list is a list that drifts, and the drift here would be an asset
quotable by one code path and unknown to the other.

## Administered prices

EMBER is administered because Hearth has no exchange listing. The two sets are **disjoint by
construction**, and an administered value may never override an asset that does have a market — that
would turn a fail-closed oracle into a fail-to-whatever-was-typed oracle (`src/rates.ts:50-53`,
`src/server.ts:341-345`).

Three refusals sit around that route:

* **A JSON number is refused**; `usd` must be a decimal string (`src/server.ts:347-354`).
  `{"usd": 0.1}` is already not 0.1 by the time this code sees it.
* **Extra precision from an operator is refused, not truncated** (`src/rates.ts:105-117`). A source
  quoting seven decimal places is truncated, because it is quoting below the scale the estate
  settles at and refusing would discard a good source over a sub-micro-dollar tail. An operator
  typing seven has a different number in mind from the one that would be stored, and silently
  truncating it is how an administered price ends up an order of magnitude from what somebody
  believes they set.
* **An administered quote never goes stale** (`src/quotes.ts:17-20`, `src/quotes.ts:448-450`). It is
  configuration, not an observation, so nothing about it decays; applying the market max-age to it
  would make EMBER unconvertible five minutes after an operator set its price, which is not what
  fail-closed means. Its age is still reported, because an operator wants to know EMBER was last
  priced in March.

`set_by` is null while the price is still the seeded default, and that null is the point: it says
nobody has yet taken responsibility for the number (`src/migrations.ts:152-156`,
`src/migrations.ts:181-186`). EMBER seeds at `250000` — 0.25 USD written as an integer literal
rather than an expression, so the seeded value cannot depend on anything Postgres computes in
floating point.

## Routes

Read out of `src/server.ts:280-443`. Every decimal in every response is a string, including the
scaled integers, and every response carries `rateScale` so a consumer never has to assume the scale
it is doing BigInt arithmetic at (`src/quotes.ts:387-388`).

| Method | Path | Who | What it does |
| --- | --- | --- | --- |
| `GET` | `/livez` | public | static (`src/server.ts:281`) |
| `GET` | `/readyz` | public | 503 removes the replica from the balancer; a **soft** probe failure leaves the report degraded but still ready (`src/server.ts:283-289`) |
| `GET` | `/metrics` | public | Prometheus text; a gauge refresh that fails is warned, not fatal — failing the scrape would lose every other metric and blind the dashboard at the moment it is needed (`src/server.ts:291-304`) |
| `GET` | `/rates` | **public** | the whole board, plus `spreadBps` (`src/server.ts:312-319`) |
| `GET` | `/rates/:asset` | **public** | one rate; asset is upper-cased so `/rates/btc` works, and an unquoted asset is a 404 (`src/server.ts:321-329`, `src/server.ts:455-463`) |
| `PUT` | `/admin/prices/:asset` | `role:admin` **or** scope `pricing:admin` | set an administered price; returns the price and the rate it produces (`src/server.ts:338-395`) |
| `GET` | `/admin/prices` | same authority | every administered price with who set it (`src/server.ts:397-412`) |
| `GET` | `/history/:asset` | `pricing:read` **or** `role:admin` | newest first; `?limit` 1–1000, default 100 (`src/server.ts:421-442`, `src/server.ts:446-453`) |

**The rate board is public on purpose** (`src/server.ts:9-12`). It is public market data and it is
public in the estate today; putting a token in front of it would break the sign-in page that shows
what a deposit is worth without making anything safer. `/history` is **not** public: it carries
`setBy`, which names an operator, and it is the record read when a conversion is questioned.

The two scopes are separate rather than one `pricing:write`, because reading operational history and
deciding what an asset with no market is worth are different authorities — a reporting job needs the
first and must never have the second (`src/server.ts:73-79`).

Two response choices are deliberate and easy to get wrong:

* **An unusable asset is listed, not omitted** (`src/server.ts:306-311`). Omitting it makes a client
  that iterates the board silently forget the asset exists, which is how a deposit page loses a coin.
* **`GET /rates/:asset` answers 200 even when the rate is unusable** (`src/server.ts:325-327`). The
  caller asked what this asset's rate is and this is the answer, complete with the reason. A 404
  would be a lie about the asset existing, and a 503 would suggest retrying helps when a stale quote
  needs a refresh, not a retry.

**A bad token is 401; a verifier that could not reach the JWKS is 503** (`src/server.ts:16-17`).
Answering 401 there would sign every user in the estate out because identity is having a bad minute.

### What a rate says

`rateView` projects a stored quote onto what a caller may settle against, or why it may not
(`src/quotes.ts:423-496`). Unusable for: no record, no quote yet, a non-positive stored value, no
observation time, or an age past `maxAgeSeconds`. **Past that age a market quote is not a discount,
it is an unknown price, and crediting against it is the money leak the oracle exists to close.** The
view still carries the age and the reason, so a client can tell "we are not quoting BTC right now,
the last round was 11 minutes ago" from "we have never quoted BTC".

The spread is applied in opposite directions on the two legs, from one constant
(`src/rates.ts:173-192`): sell is `usd × (10000 − bps) / 10000`, buy is `usd × 10000 / (10000 − bps)`.
The buy price is necessarily higher — quoting a purchase at the sell rate would let anyone convert
coin out and straight back in at a profit, and repeat it until the treasury is empty. A price so
small that the spread rounds the sell leg to zero is reported unusable rather than quoted, because
quoting zero would let a conversion take coin and credit no Shards at all
(`src/quotes.ts:468-472`).

## Background work

Two leased jobs and no timers — rule 8, and **this service is the clearest case for it in the
estate** (`src/jobs.ts:1-25`). The oracle it replaces runs `setInterval(tick, …)` guarded by nothing
at all; with three replicas that is three rounds a minute against four exchanges, three times the
rate-limit consumption, and three different medians in three different Maps, so which rate a user
was quoted depended on which replica the balancer picked.

| Job | Lease key | Cadence | What two at once would break |
| --- | --- | --- | --- |
| `outbox.relay` | `stream` | 1 s | the outbox stream — two relays deliver one batch twice (`src/jobs.ts:62`) |
| `price.refresh` | `global` | `PRICING_REFRESH_SECONDS`, default 60 s | the quote set, which is one set for the whole estate. Keying on the **asset** instead would let four rounds run concurrently, each requesting every asset from every exchange, and the rate-limit rejection that follows would take out the source count for all of them at once (`src/jobs.ts:16-24`) |

The refresh heartbeats after its writes: the round is short, but the lease must outlive the slowest
exchange and four HTTP deadlines can add up, and the heartbeat is what stops a second replica
claiming the refresh while this one is still finishing it (`src/jobs.ts:125-128`).

A recurring job is re-armed from the runner's `completed` event and never from inside its own
handler — the runner deletes the row after the handler returns, so a self-enqueue would be deleted a
moment later and the schedule would stop (`src/jobs.ts:74-85`). **A dead-lettered recurring job is
deliberately not re-armed**: the row stays, `jobs_dead_total` increments and `jobs_overdue` climbs.
A refresh that has stopped is an estate whose rates go stale and then, correctly, unusable — and
that must be visible rather than hidden behind a busy loop.

## The database

Four migrations, expand/contract only, run by `src/migrator.ts` and never by the service
(`src/migrations.ts:1-10`). A released migration is immutable: `@cloudsforge/db` checksums each one
and refuses a run where the text changed after it was applied, because two databases would then
disagree about what "version 4" means. The fix for a wrong migration is always a new migration.

| Table | Holds |
| --- | --- |
| `price_quotes` | one row per asset — **the last good quote and the last failure, together** |
| `administered_prices` | the operator-set price for each administered asset, with who set it |
| `price_history` | every accepted round and every administered change, append-only |
| `outbox`, `event_subscriptions`, `outbox_deliveries` | the standard relay tables — see [Known gaps](#known-gaps) |
| `inbox` | `(topic, event_id)` primary key; the key **is** the dedupe (`src/migrations.ts:93-101`) |
| `jobs` | `@cloudsforge/jobs`, imported verbatim rather than hand-copied (`src/migrations.ts:34-42`) |

The constraints and column choices that carry meaning:

| Constraint / choice | Refuses or prevents | Why here |
| --- | --- | --- |
| `usd_scaled numeric(78,0)`, **never `double precision`** | a rate that is not the rate that was written | Postgres' `float8` has 53 bits of mantissa, so a fixed-point rate stored as a float and read back is not necessarily the same number — which is the whole failure this service exists to avoid. It is read back as a string and converted with BigInt (`src/migrations.ts:118-122`, `src/quotes.ts:101-103`) |
| `check (usd_scaled > 0)` on all three tables | a zero or negative price, from **any** writer | including psql; a zero price is a conversion that credits nothing (`src/migrations.ts:122`, `:151`, `:166`) |
| `check (source in ('market','administered'))` | a third source kind appearing by accident | the distinction is carried to the client, because a conversion settled against an administered price was priced by a person and not by a market (`src/migrations.ts:124-127`) |
| `quoted_at` separate from `updated_at` | a failed round making a stale price look fresh | staleness is about the age of the **observation**; a failed round touches `updated_at` only (`src/migrations.ts:134-138`, `src/quotes.ts:216-225`) |
| the quote and its failure in **one row** | a rate board that cannot say why an asset is unusable | the old oracle kept them in two Maps that could disagree, so a coin whose round failed kept serving the previous median with no indication the last refresh was rejected (`src/migrations.ts:109-114`) |
| `outbox_unpublished_idx`, partial on `published_at is null` | an index the size of history | it stays the size of the backlog (`src/migrations.ts:61-65`) |
| `outbox_deliveries` PK `(event_id, subscription_id)` | one failing subscriber blocking or re-fanning the rest | with one flag on the outbox row, a single broken subscriber either blocks every other subscriber or causes redelivery to all of them on each retry (`src/migrations.ts:76-86`) |
| `price_history.id` is an identity `bigint`, not a v4 uuid | random insert positions in an append-only table | history is read in time order per asset, and a random key puts every insert in a different B-tree leaf (`src/migrations.ts:159-164`) |

An accepted round writes the quote **and** its history row in one transaction, because the history
is the evidence for the quote (`src/quotes.ts:155-165`). A quote with no history behind it is a rate
nobody can explain after the fact, which is the position the estate is in today: its oracle keeps no
history at all, so a disputed conversion cannot be checked against what the sources actually said.
An administered change writes three rows in one transaction for the same reason
(`src/quotes.ts:244-251`), and there is no cache to fall out of step — the next `GET /rates` on any
replica reads the row.

**A failed round does not erase the last good quote**, it records why it failed
(`src/quotes.ts:209-215`). Deleting the quote would turn a transient exchange outage into an
immediate refusal to convert; keeping it lets the staleness rule decide, which is a decision about
age rather than about one unlucky fetch.

## Configuration

Every variable the service reads is declared in `src/env.ts` and nowhere else, validated at import,
with one hand-built structured `fatal` line on failure — nothing that can itself fail may sit
between a configuration error and the report of it (`src/env.ts:172-179`). Non-integers are refused
rather than coerced.

| Variable | Default | If it is wrong |
| --- | --- | --- |
| `PRICING_DATABASE_URL` | — | refuses to start (`src/env.ts:155`) |
| `IDENTITY_JWKS_URL`, `IDENTITY_ISSUER` | — | refuses to start (`src/env.ts:159-160`) |
| `OUTBOX_SIGNING_SECRET` | — | refuses to start; must be long enough and must not be a known placeholder (`src/env.ts:161`) |
| `PRICING_MIN_SOURCES` | `2` (1–4) | **2 is the floor**: the smallest number at which the median is not one exchange's opinion. 1 is permitted only so a single-source development environment is possible, and the divergence check is inert at that setting because there is nothing to diverge from (`src/env.ts:100-106`, `:145`) |
| `PRICING_MAX_DIVERGENCE_BPS` | `200` (1–10 000) | too high and a bad print is laundered into a rate; too low and every round is rejected (`src/env.ts:107-112`, `:164`) |
| `PRICING_MAX_AGE_SECONDS` | `300` (5–86 400) | past this a market rate is unusable and says why. A stale quote is not a discount, it is an unknown price (`src/env.ts:113-119`, `:165`) |
| `PRICING_CONVERSION_SPREAD_BPS` | `100` (0–**2 000**) | 10 000 would divide by zero on the buy leg; the bound is set far below that anyway, because 2 000 bps is a 20% spread and no honest platform charges it (`src/env.ts:146-148`) |
| `PRICING_SOURCE_TIMEOUT_MS` | `4000` (100–60 000) | a slow exchange holding the round open (`src/env.ts:120-121`, `:166`) |
| `PRICING_REFRESH_SECONDS` | `60` (5–3 600) | how often the leased refresh runs — once for the estate, not once per replica (`src/env.ts:122-123`, `:167`) |
| `PRICING_DATABASE_POOL_MAX` | `10` (1–100) | a pool larger than the database's budget divided by the replica count exhausts Postgres for everything else (`src/env.ts:156-158`) |
| `PORT` | `4000` | (`src/env.ts:151`) |
| `LOG_LEVEL` | `info` | outside debug/info/warn/error it refuses to start (`src/env.ts:140-143`) |
| `INSTANCE_ID` | hostname | names this replica in `jobs.locked_by` (`src/env.ts:162`) |
| `CLOUDSFORGE_TAG` | `dev` | reported on every log line (`src/env.ts:153`) |

`OTEL_*` is read by the OpenTelemetry SDK loaded ahead of the process rather than by this service,
so under rule 9 it is not declared here.

## What it talks to

| Upstream | What for | When it is down |
| --- | --- | --- |
| CoinGecko, Coinbase, Kraken, Binance | market quotes, once per round | one down costs one source; below `PRICING_MIN_SOURCES` the round records `too_few_sources` and the previous quote stands until it ages out — **fail-closed, by staleness** |
| `micro-identity` | JWKS, to verify tokens on the admin and history routes | those routes answer 503; the public rate board is unaffected |

It calls no other CloudsForge service. Consumers read `GET /rates`.

## Running it

```bash
pnpm install
cp .env.example .env      # every value there is a placeholder; src/env.ts refuses to boot on one
pnpm migrate              # a one-shot job. Never run from the service.
pnpm start
```

The database-backed suite needs a **real Postgres**, and the database name must contain `test`:
`resetPricing` truncates every table and restores the EMBER seed, and that check is the difference
between a red build and an emptied environment (`src/testsupport.ts:22-27`).

```bash
docker run -d --rm --name pricing-pg \
  -e POSTGRES_USER=pricing -e POSTGRES_PASSWORD=pricing -e POSTGRES_DB=pricing_test \
  -p 55433:5432 postgres:17-alpine

PRICING_TEST_DATABASE_URL=postgres://pricing:pricing@127.0.0.1:55433/pricing_test pnpm test
pnpm check                # typecheck, then the suite
```

Without that variable `quotes`, `oracle` and `server` skip and only the pure files run. **CI fails
the build when that happens** — a green run that skipped its database tests is worse than a red one,
because it is believed.

`--test-concurrency=1` is required rather than preferred: every database test file truncates between
cases, `node:test` runs files in parallel by default, and a `TRUNCATE` takes an
`AccessExclusiveLock` that deadlocks against another file's inserts with `40P01`
(`package.json:14-15`).

| File | Covers | Postgres |
| --- | --- | --- |
| `src/rates.test.ts` | parsing, formatting, the median, divergence, the spread legs, shards | no |
| `src/nofloat.test.ts` | greps the shipped sources and the DDL for float arithmetic and `double precision` | no |
| `src/migrations.test.ts` | the DDL text — the numeric columns, the checks, the partial index | no |
| `src/env.test.ts` | every bound and every refusal | no |
| `src/quotes.test.ts` | the upserts, the transactions, staleness, the administered exemption | **yes** |
| `src/oracle.test.ts` | whole rounds against fake sources — divergence, too few sources, a source that throws | **yes** |
| `src/server.test.ts` | the routes and the auth mapping, against a token-keyed fake verifier so no JWKS is needed | **yes** |

## Known gaps

* **This service publishes no events, but ships the machinery to.** Migration 2 creates `outbox`,
  `event_subscriptions` and `outbox_deliveries`, `outbox.relay` runs once a second, and
  `OUTBOX_SIGNING_SECRET` is required at boot (`src/env.ts:161`) — yet `withOutbox`
  (`src/outbox.ts:68`) has no caller anywhere in `src/`, so the relay sweeps an empty table for
  ever and the secret signs nothing. Sibling `micro-policy` faced the same choice and deleted its
  outbox instead, recording the registry event that would bring it back. Neither shape is wrong,
  but the two should not be decided differently by accident: either a `pricing.*` topic is accepted
  into `contracts-events` and a round starts emitting, or these tables and that secret should go
  the way policy's did.
* **`recordAccepted` converts `divergenceBps` from BigInt to a JS number**
  (`src/quotes.ts:169`), because `divergence_bps` is an `integer` column. It is the only place a
  BigInt becomes a number on this path, and it is basis points rather than a rate. The scan does
  not flag it, and not because it is allowlisted: `Number(` is deliberately not banned outright —
  only float *arithmetic* and the conversions that produce one from a scaled value
  (`src/nofloat.test.ts:34-39`). So the guard against this line drifting into arithmetic is the
  scan's shape rule rather than anything naming this line. Worth knowing it exists.
* **CoinGecko quotes as a JSON number**, so its value has been through a double before this code
  can see it (`src/sources.ts:41-43`). It is one of four inputs to a median, which is the
  mitigation, not a fix.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
