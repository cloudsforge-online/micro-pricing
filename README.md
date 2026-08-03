# micro-pricing

The price oracle: four independent sources, a median in BigInt fixed point, divergence rejection,
fail-closed staleness, and administered prices for assets with no market. **Quotes live in a table,
not in a per-replica `Map`.**

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

It owns market sources, the median oracle, administered prices, spread policy, rate history and the
valuation service.

```
pnpm install
pnpm migrate     # a one-shot job. Never run from the service.
pnpm start
pnpm check
```

Configuration is documented in `.env.example`; every value there is a placeholder, and `src/env.ts`
refuses to boot on one.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, under
human direction and review.
