# `modules/usage-cost`

Provider-agnostic usage cost calculation helpers.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/usage-cost/index.ts` (tests may import internals).

## Cost table format
`plugins/configs/usage-costs.json`:

```json
{
  "example-provider": {
    "example-model": {
      "input": 0.25,
      "output": 0.5,
      "cached": 0.1
    }
  }
}
```

All values are **cost per million tokens**. `cached` is optional; when missing, cached tokens are billed at the input rate.

## Exports
- `calculateUsageCost({ provider, model, usage, table? })` – returns cost rounded to 6 decimals or `undefined`.
- `attachUsageCostIfMissing({ provider, model, usage, table? })` – mutates `usage.cost` when computable and returns the computed cost (or `undefined`).
- `getUsageCostRates(provider, model, table?)` – resolves normalized rates for a provider/model.
- `loadUsageCostTable()` – loads/caches the cost table (prefers cwd, falls back to package).
- `resetUsageCostTableCache()` – clears cache (tests).

## Cached token accounting
`calculateUsageCost` assumes `usage.promptTokens` includes cached tokens and subtracts `usage.cachedTokens` before applying input rates. If a compat reports prompt tokens **excluding** cached tokens, set `promptTokensIncludeCached: false` in the usage extraction spec so cached tokens are billed without subtraction.
