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
- `getUsageCostRates(provider, model, table?)` – resolves normalized rates for a provider/model.
- `loadUsageCostTable()` – loads/caches the cost table (searches package + cwd).
- `resetUsageCostTableCache()` – clears cache (tests).
