import fetch from 'node-fetch';

const CACHE_TTL_MS = Math.max(60_000, Number(process.env.NEWS_CACHE_TTL_MS || 10 * 60_000));
const CACHE_MAX_ENTRIES = Math.max(10, Number(process.env.NEWS_CACHE_MAX_ENTRIES || 100));
const REQUEST_TIMEOUT_MS = Math.max(2_000, Number(process.env.NEWS_REQUEST_TIMEOUT_MS || 8_000));
const cache = new Map();
const pending = new Map();
const sourceQueues = new Map();
const sourceLastRequestAt = new Map();
const SOURCE_MIN_INTERVAL_MS = Math.max(250, Number(process.env.NEWS_SOURCE_MIN_INTERVAL_MS || 1_200));

const MARKET_SECTORS = [
  'bitcoin', 'crypto regulation', 'SEC', 'oil', 'Brent', 'OPEC', 'Iran oil',
  'Trump tariffs', 'MiCA', 'stablecoin', 'interest rates', 'inflation',
];

function cacheKey(topic) { return String(topic || 'market').trim().toUpperCase(); }
function pruneCache() {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of oldest.slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
}
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
/** Serializes provider calls to remain below API rate limits even for different coins. */
function fetchProviderJson(provider, url) {
  const previous = sourceQueues.get(provider) || Promise.resolve();
  const request = previous.catch(() => {}).then(async () => {
    const elapsed = Date.now() - (sourceLastRequestAt.get(provider) || 0);
    if (elapsed < SOURCE_MIN_INTERVAL_MS) await sleep(SOURCE_MIN_INTERVAL_MS - elapsed);
    sourceLastRequestAt.set(provider, Date.now());
    return fetchJson(url);
  });
  sourceQueues.set(provider, request);
  return request;
}
function gdeltQuery(topic) {
  const terms = [topic, ...MARKET_SECTORS].filter(Boolean).map((term) => `"${String(term).replace(/"/g, '')}"`);
  return `(${terms.join(' OR ')})`;
}
function normalizeGdeltDate(value) {
  const raw = String(value || '');
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return raw || null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}
function asGdeltArticle(article) {
  return {
    id: `gdelt:${article.url || article.title || Math.random()}`,
    source: 'gdelt', title: article.title || '', description: article.seendate || '',
    url: article.url || '', publishedAt: normalizeGdeltDate(article.seendate),
    sourceName: article.domain || 'GDELT', language: article.language || 'en',
  };
}
function asMarketauxArticle(article) {
  return {
    id: `marketaux:${article.uuid || article.url || article.title || Math.random()}`,
    source: 'marketaux', title: article.title || '', description: article.description || '',
    url: article.url || '', publishedAt: article.published_at || null,
    sourceName: article.source || 'Marketaux', language: article.language || 'en',
    entities: article.entities || [],
  };
}
async function getGdelt(topic) {
  const params = new URLSearchParams({ query: gdeltQuery(topic), mode: 'ArtList', format: 'json', maxrecords: '50', timespan: process.env.GDELT_TIMESPAN || '24h', sort: 'HybridRel' });
  const data = await fetchProviderJson('gdelt', `https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
  return Array.isArray(data.articles) ? data.articles.map(asGdeltArticle) : [];
}
async function getMarketaux(topic) {
  const token = process.env.MARKETAUX_API_TOKEN;
  if (!token) return [];
  const params = new URLSearchParams({ api_token: token, search: `${topic} ${MARKET_SECTORS.join(' ')}`, language: 'en', limit: '50' });
  const data = await fetchProviderJson('marketaux', `https://api.marketaux.com/v1/news/all?${params}`);
  return Array.isArray(data.data) ? data.data.map(asMarketauxArticle) : [];
}

/** Gets raw news from at most one GDELT and one Marketaux request per cache window. */
export async function fetchNewsArticles(topic) {
  const key = cacheKey(topic);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) return { articles: cached.articles, cache: 'hit', sourceErrors: cached.sourceErrors };
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    const [gdelt, marketaux] = await Promise.allSettled([getGdelt(key), getMarketaux(key)]);
    const articles = [
      ...(gdelt.status === 'fulfilled' ? gdelt.value : []),
      ...(marketaux.status === 'fulfilled' ? marketaux.value : []),
    ];
    const sourceErrors = [gdelt, marketaux].flatMap((result, index) => result.status === 'rejected' ? [{ source: index === 0 ? 'gdelt' : 'marketaux', message: result.reason?.message || 'request failed' }] : []);
    if (!articles.length && cached) return { articles: cached.articles, cache: 'stale', sourceErrors };
    cache.set(key, { articles, sourceErrors, updatedAt: Date.now() });
    pruneCache();
    return { articles, cache: 'miss', sourceErrors };
  })();
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}

export function getNewsCacheStatus() {
  return { entries: cache.size, ttlMs: CACHE_TTL_MS, inflight: pending.size };
}
