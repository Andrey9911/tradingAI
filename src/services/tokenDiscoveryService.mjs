const DEFAULT_DISCOVERY_FILTERS = {
  liquidityUsd: [10000, 150000],
  holders: [500, 10000],
  volume24h: [25000, 500000],
  ageMinutes: [10, 1440] // от 10 минут до суток
};

const DEFAULT_SOURCE_TIMEOUT_MS = parseInt(process.env.TOKEN_DISCOVERY_TIMEOUT_MS || '8000', 10);

const SUSPICIOUS_TOKEN_FLAGS = [
  'honeypot',
  'blacklist',
  'hiddenMint',
  'hiddenFreeze',
  'suspiciousTaxes',
  'proxyScam',
];

const DEXSCREENER_SEARCH_QUERIES = ['pump', 'solana', 'meme', 'raydium', 'bonk', 'trump'];
const GECKOTERMINAL_NETWORKS = ['solana', 'bsc', 'ton'];

const BLUE_CHIP_SYMBOLS = new Set([
  'BTC',
  'WBTC',
  'ETH',
  'WETH',
  'BNB',
  'WBNB',
  'SOL',
  'USDT',
  'USDC',
  'DAI',
  'FDUSD',
  'TUSD',
]);

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asPositiveNumber(...values) {
  for (const value of values) {
    const num = toNumber(value, NaN);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

function getNested(obj, path) {
  return path.reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function uniqBy(items, getKey) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeChain(chain) {
  const value = String(chain || '').toLowerCase();
  if (value === 'ethereum') return 'eth';
  if (value === 'binance-smart-chain') return 'bsc';
  if (value === 'solana') return 'sol';
  if (value === 'ton' || value === 'the open network') return 'ton';
  return value;
}

function minutesSince(dateValue) {
  if (!dateValue) return 0;
  const ts = typeof dateValue === 'number' ? dateValue : Date.parse(dateValue);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (Date.now() - ts) / 60000);
}

function detectRiskFlags(raw) {
  const flattened = JSON.stringify(raw).toLowerCase();
  return {
    honeypot: raw?.isHoneypot === true || flattened.includes('"honeypot":true') || flattened.includes('"is_honeypot":true'),
    blacklist: flattened.includes('blacklist') && !flattened.includes('"blacklist":false'),
    hiddenMint: flattened.includes('hidden mint') || flattened.includes('hidden_mint') || flattened.includes('"mint_authority":true'),
    hiddenFreeze: flattened.includes('hidden freeze') || flattened.includes('hidden_freeze') || flattened.includes('"freeze_authority":true'),
    suspiciousTaxes:
      flattened.includes('suspicious tax') ||
      flattened.includes('high tax') ||
      toNumber(raw?.tax, 0) > 20 ||
      toNumber(raw?.buyTax, 0) > 20 ||
      toNumber(raw?.sellTax, 0) > 20,
    proxyScam: flattened.includes('proxy scam') || flattened.includes('proxy_scam'),
  };
}

/** Проверяет наличие флагов риска в нормализованном объекте токена. */
function hasRiskFlags(token) {
  return SUSPICIOUS_TOKEN_FLAGS.some(flag => token.riskFlags?.[flag] === true);
}

/** Применяет фильтры по ликвидности, холдерам, объему и возрасту к списку токенов. */
function applyFilters(tokens, filters, isDisableFiltr) {
  //если фильтры отключены
  if (isDisableFiltr) return tokens
  return tokens.filter(token => {
    // 1. Стандартные проверки (оставляем как было)
    if (BLUE_CHIP_SYMBOLS.has(String(token.symbol || '').toUpperCase())) return false;
    if (hasRiskFlags(token)) return false;

    // 2. Проверка ликвидности (диапазон)
    const liq = parseFloat(token.liquidityUsd || 0);
    if (liq < filters.liquidityUsd[0] || liq > filters.liquidityUsd[1]) return false;

    // 3. Проверка холдеров/активности (оставляем твою логику, но в рамках диапазона)
    // Если ты хочешь диапазон и для холдеров:
    const activity = Math.max(token.holders || 0, (token.buys24h || 0) + (token.sells24h || 0));
    if (activity < filters.holders[0] || activity > filters.holders[1]) return false;

    // 4. Проверка объема (диапазон)
    const vol = parseFloat(token.volume24h || 0);
    if (vol < filters.volume24h[0] || vol > filters.volume24h[1]) return false;

    // 5. Проверка возраста (диапазон)
    const age = parseFloat(token.ageMinutes || 0);
    if (age < filters.ageMinutes[0] || age > filters.ageMinutes[1]) return false;

    return true;
  });
}

/** Рассчитывает скоринг токена на основе ликвидности, объема, холдеров и соотношения покупок. */
function scoreToken(token) {
  const liquidityScore = Math.log10(token.liquidityUsd + 1) * 20;
  const volumeScore = Math.log10(token.volume24h + 1) * 22;
  const holderScore = Math.log10(token.holders + 1) * 18;
  const buyPressure = token.buys24h + token.sells24h > 0
    ? (token.buys24h / (token.buys24h + token.sells24h)) * 20
    : 0;
  const agePenalty = Math.min(token.ageMinutes / 1440, 1) * 10;
  return liquidityScore + volumeScore + holderScore + buyPressure - agePenalty;
}

function normalizeDexScreenerPair(pair, dex = 'DexScreener') {
  const txns24h = pair.txns?.h24 || {};
  const baseToken = pair.baseToken || {};
  return {
    chain: normalizeChain(pair.chainId),
    address: firstString(baseToken.address, pair.baseTokenAddress, pair.tokenAddress),
    symbol: firstString(baseToken.symbol, pair.symbol),
    price: asPositiveNumber(pair.priceUsd, pair.priceNative),
    marketCap: asPositiveNumber(pair.marketCap, pair.fdv),
    liquidityUsd: asPositiveNumber(pair.liquidity?.usd),
    volume24h: asPositiveNumber(pair.volume?.h24),
    buys24h: toNumber(txns24h.buys, 0),
    sells24h: toNumber(txns24h.sells, 0),
    holders: asPositiveNumber(pair.holders, pair.info?.holders, pair.baseToken?.holders),
    ageMinutes: minutesSince(pair.pairCreatedAt),
    dex: firstString(pair.dexId, dex),
    pairAddress: firstString(pair.pairAddress),
    devWallet: firstString(pair.info?.creator, pair.creator, pair.deployer, pair.owner),
    source: dex,
    riskFlags: detectRiskFlags(pair),
  };
}

function normalizeGeckoPool(pool) {
  const attrs = pool.attributes || {};
  const relationships = pool.relationships || {};
  const baseToken = getNested(relationships, ['base_token', 'data']) || {};
  const txns = attrs.transactions?.h24 || {};
  return {
    chain: normalizeChain(pool.id?.split('_')?.[0] || baseToken.id?.split('_')?.[0]),
    address: firstString(baseToken.id?.split('_')?.slice(1).join('_'), attrs.base_token_address, attrs.address),
    symbol: firstString(attrs.name?.split(' / ')?.[0], attrs.base_token_symbol),
    price: asPositiveNumber(attrs.base_token_price_usd, attrs.quote_token_price_usd),
    marketCap: asPositiveNumber(attrs.market_cap_usd, attrs.fdv_usd),
    liquidityUsd: asPositiveNumber(attrs.reserve_in_usd),
    volume24h: asPositiveNumber(attrs.volume_usd?.h24),
    buys24h: toNumber(txns.buys, 0),
    sells24h: toNumber(txns.sells, 0),
    holders: asPositiveNumber(attrs.holders, attrs.base_token_holders),
    ageMinutes: minutesSince(attrs.pool_created_at),
    dex: firstString(attrs.dex_id, 'GeckoTerminal'),
    pairAddress: firstString(attrs.address, pool.id),
    devWallet: firstString(attrs.creator_address, attrs.deployer_address, attrs.owner_address),
    source: 'GeckoTerminal',
    riskFlags: detectRiskFlags(pool),
  };
}

function normalizePumpToken(token) {
  const virtualSolReserves = toNumber(token.virtual_sol_reserves, 0) / 1_000_000_000;
  const realSolReserves = toNumber(token.real_sol_reserves, 0) / 1_000_000_000;
  const solPriceUsd = parseFloat(process.env.SOL_PRICE_USD || '180');
  return {
    chain: 'solana',
    address: firstString(token.mint, token.address, token.tokenAddress),
    symbol: firstString(token.symbol, token.ticker, token.name),
    price: asPositiveNumber(token.price, token.usd_market_cap && token.total_supply ? token.usd_market_cap / token.total_supply : 0),
    marketCap: asPositiveNumber(token.usd_market_cap, token.marketCap, token.market_cap),
    liquidityUsd: asPositiveNumber(token.liquidityUsd, token.liquidity_usd, realSolReserves * solPriceUsd * 2, virtualSolReserves * solPriceUsd * 2),
    volume24h: asPositiveNumber(token.volume24h, token.volume_24h, token.volume),
    buys24h: toNumber(token.buys24h ?? token.buys_24h, 0),
    sells24h: toNumber(token.sells24h ?? token.sells_24h, 0),
    holders: asPositiveNumber(token.holders, token.holder_count, token.num_holders, token.reply_count),
    ageMinutes: minutesSince(token.created_timestamp || token.createdAt || token.created_at),
    dex: 'Pump.fun',
    pairAddress: firstString(token.raydium_pool, token.pairAddress, token.bonding_curve),
    devWallet: firstString(token.creator, token.deployer, token.owner, token.user),
    source: 'Pump.fun',
    riskFlags: detectRiskFlags(token),
  };
}

/** Выполняет HTTP GET запрос с таймаутом и возвращает JSON. */
async function fetchJson(url, timeoutMs = DEFAULT_SOURCE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'tradingai-token-discovery/1.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Инициализирует и возвращает фильтры для поиска токенов из сессии Telegram-пользователя. */
export function getTokenDiscoveryFilters(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.tokenDiscoveryFilters) {
    ctx.session.tokenDiscoveryFilters = { ...DEFAULT_DISCOVERY_FILTERS };
  }


  ctx.session.tokenDiscoveryFilters.liquidityUsd ??= DEFAULT_DISCOVERY_FILTERS.liquidityUsd;
  ctx.session.tokenDiscoveryFilters.holders ??= DEFAULT_DISCOVERY_FILTERS.holders;
  ctx.session.tokenDiscoveryFilters.volume24h ??= DEFAULT_DISCOVERY_FILTERS.volume24h;
  ctx.session.tokenDiscoveryFilters.ageMinutes ??= DEFAULT_DISCOVERY_FILTERS.ageMinutes;

  return ctx.session.tokenDiscoveryFilters;
}

export class TokenDiscoveryService {
  constructor({ timeoutMs = DEFAULT_SOURCE_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
  }

  /** Агрегирует, фильтрует и сортирует топ токенов из всех доступных DEX-источников. */
  async discoverTopTokens(filters = DEFAULT_DISCOVERY_FILTERS, onStatusUpdate = null, isDisableFiltr) {
    const [pumpTokens, dexTokens, geckoTokens] = await Promise.all([
      this.fetchDexScreenerTokens(onStatusUpdate),
      this.fetchPumpFunTokens(onStatusUpdate),
      this.fetchGeckoTerminalTokens(onStatusUpdate),
    ]);

    const merged = uniqBy(
      [...pumpTokens, ...dexTokens, ...geckoTokens],
      token => `${token.chain}:${token.address || token.pairAddress}`.toLowerCase(),
    );

    if (isDisableFiltr) {
      return merged
        .map(token => ({ ...token, score: scoreToken(token) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    }
    // Передаем токены и новые фильтры-диапазоны
    return applyFilters(merged, filters)
      .map(token => ({ ...token, score: scoreToken(token) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  /** Получает и нормализует список свежих токенов с Pump.fun. */
  async fetchPumpFunTokens(onStatusUpdate = null) {
    const urls = [
      'https://frontend-api-v3.pump.fun/coins?offset=0&limit=10&sort=created_timestamp&order=DESC&includeNsfw=false',
      'https://frontend-api.pump.fun/coins?offset=0&limit=10&sort=created_timestamp&order=DESC&includeNsfw=false',
    ];

    for (const url of urls) {
      try {
        const data = await fetchJson(url, this.timeoutMs);
        const rows = Array.isArray(data) ? data : data?.coins || data?.data || [];
        return rows.map(normalizePumpToken).filter(token => token.address || token.pairAddress);
      } catch (err) {
        if (onStatusUpdate) await onStatusUpdate(`⚠️ Pump.fun недоступен: ${err.message}`);
        console.log(err.message);
        
      }
    }

    return [];
  }

  /** Выполняет поиск трендовых токенов через API DexScreener по популярным запросам. */
  async fetchDexScreenerTokens(onStatusUpdate = null) {
    const results = [];
    await Promise.all(DEXSCREENER_SEARCH_QUERIES.map(async query => {
      try {
        const data = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, this.timeoutMs);
        console.log(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
        
        const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
        results.push(...pairs.map(pair => normalizeDexScreenerPair(pair)));
      } catch (err) {
        if (onStatusUpdate) await onStatusUpdate(`⚠️ DexScreener ${query}: ${err.message}`);
      }
    }));

    return results.filter(token => token.address || token.pairAddress);
  }

  /** Запрашивает и нормализует трендовые пулы из GeckoTerminal для поддерживаемых сетей. */
  async fetchGeckoTerminalTokens(onStatusUpdate = null) {
    const results = [];
    await Promise.all(GECKOTERMINAL_NETWORKS.map(async network => {
      try {
        const data = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?include=base_token`, this.timeoutMs);
        const pools = Array.isArray(data?.data) ? data.data : [];
        results.push(...pools.map(normalizeGeckoPool));
      } catch (err) {
        if (onStatusUpdate) await onStatusUpdate(`⚠️ GeckoTerminal ${network}: ${err.message}`);
      }
    }));

    return results.filter(token => token.address || token.pairAddress);
  }
}
