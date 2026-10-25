# News pipeline

`server.mjs` requests GDELT and, when `MARKETAUX_API_TOKEN` is configured, Marketaux. It caches each topic for ten minutes by default and serializes per-provider requests (`NEWS_SOURCE_MIN_INTERVAL_MS=1200`) to protect API limits.

`searchNews.mjs` converts the raw response into the object used by `signals.mjs`:

```js
{
  topic: 'BTC',
  overall: 'bullish' | 'bearish' | 'neutral',
  sentimentScore: 0.123,
  'important-news': [/* descending importance */]
}
```

Configuration: `MARKETAUX_API_TOKEN` (optional), `NEWS_CACHE_TTL_MS`, `NEWS_CACHE_MAX_ENTRIES`, `NEWS_SOURCE_MIN_INTERVAL_MS`, `NEWS_REQUEST_TIMEOUT_MS`, and `GDELT_TIMESPAN`.
