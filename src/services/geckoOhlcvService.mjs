import { RSI, EMA } from 'technicalindicators';
import { detectCandlestickPatterns } from './candlestickPatternService.mjs';

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Безопасное число с fallback
 * @param {any} value 
 * @param {number} fallback 
 * @returns {number}
 */
function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Запрос к HTTP с AbortController и таймаутом
 * @param {string} url 
 * @param {Object} [options] 
 * @returns {Promise<any>}
 */
async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json;version=20230203',
        'user-agent': 'tradingai-gecko-ohlcv/1.0',
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GeckoTerminal API ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Нормализация идентификатора сети для GeckoTerminal API
 * @param {string} chain 
 * @returns {string}
 */
export function normalizeGeckoNetwork(chain) {
  const c = String(chain || '').toLowerCase().trim();
  if (c === 'solana' || c === 'sol') return 'solana';
  if (c === 'ethereum' || c === 'eth') return 'eth';
  if (c === 'binance-smart-chain' || c === 'bsc') return 'bsc';
  if (c === 'ton') return 'ton';
  if (c === 'robinhood' || c === 'robinhood-chain' || c === 'rh-evm') return 'robinhood';
  if (c === 'arbitrum' || c === 'arbitrum-one') return 'arbitrum';
  if (c === 'base') return 'base';
  if (c === 'polygon' || c === 'matic') return 'polygon_pos';
  if (c === 'avalanche' || c === 'avax') return 'avax';
  return c;
}

/**
 * @typedef {Object} TimeframeTA
 * @property {string} timeframe - '30m' | '1h' | '4h' | '1w'
 * @property {number|null} currentPrice - Текущая цена закрытия
 * @property {number|null} rsi - Значение RSI (14)
 * @property {number|null} ema20 - Значение EMA 20
 * @property {number|null} ema50 - Значение EMA 50
 * @property {string} trend - 'Bullish' | 'Bearish' | 'Neutral'
 * @property {number|null} support - Уровень поддержки (минимум 20 последних свечей)
 * @property {number|null} resistance - Уровень сопротивления (максимум 20 последних свечей)
 * @property {number|null} volumeSpike - Всплеск объема (отношение последнего бара к среднему)
 * @property {Array<{name: string, bias: 'bullish'|'bearish'|'neutral', timestamp: number, close: number, volumeRatio: number|null, nearSupport: boolean, nearResistance: boolean, trendAligned: boolean}>} patterns - Свежие закрытые свечные паттерны с контекстом
 * @property {number} candlesCount - Количество проанализированных свечей
 */

/**
 * @typedef {Object} MultiTimeframeResult
 * @property {string} poolAddress - Адрес пула
 * @property {string} network - Сеть
 * @property {Record<string, TimeframeTA>} timeframes - Результаты ТА по таймфреймам ('30m', '1h', '4h', '1w')
 * @property {string} overallTrend - Сводный тренд по всем таймфреймам
 * @property {string|null} error - Сообщение об ошибке (если есть)
 */

export class GeckoOhlcvService {
  /**
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   */
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Поиск адреса пула для токена
   * @param {string} network 
   * @param {string} tokenAddress 
   * @returns {Promise<string|null>}
   */
  async getPoolAddress(network, tokenAddress) {
    if (!network || !tokenAddress) return null;
    try {
      const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/pools?page=1`;
      const data = await fetchJson(url, { timeoutMs: this.timeoutMs });
      const pools = data?.data || [];
      if (pools.length > 0 && pools[0]?.attributes?.address) {
        return pools[0].attributes.address;
      }
    } catch (err) {
      console.warn(`⚠️ Error getting pool address for ${network}:${tokenAddress}:`, err.message);
    }
    return null;
  }

  /**
   * Запрос OHLCV свечей от GeckoTerminal API
   * Endpoint: GET /networks/{network}/pools/{pool_address}/ohlcv/{timeframe}
   * 
   * @param {string} network 
   * @param {string} poolAddress 
   * @param {'minute'|'hour'|'day'} apiTimeframe 
   * @param {number} aggregate 
   * @param {number} limit 
   * @returns {Promise<Array<[number, number, number, number, number, number]>>} Массив свечей [timestamp, open, high, low, close, volume] (от старых к новым)
   */
  async fetchOhlcvCandles(network, poolAddress, apiTimeframe, aggregate = 1, limit = 200) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/${apiTimeframe}?aggregate=${aggregate}&limit=${limit}`;
    const data = await fetchJson(url, { timeoutMs: this.timeoutMs });
    const rawList = data?.data?.attributes?.ohlcv_list || [];
    
    // GeckoTerminal возвращает свечи в порядке от новых к старым (desc).
    // Переворачиваем, чтобы было от старых к новым (asc) для расчёта индикаторов.
    return rawList.reverse();
  }

  /**
   * Расчёт показателей ТА по массиву свечей
   * @param {Array<[number, number, number, number, number, number]>} candles 
   * @param {string} timeframeLabel 
   * @returns {TimeframeTA}
   */
  calculateTAFromCandles(candles, timeframeLabel) {
    if (!candles || candles.length === 0) {
      return {
        timeframe: timeframeLabel,
        currentPrice: null,
        rsi: null,
        ema20: null,
        ema50: null,
        trend: 'Neutral',
        support: null,
        resistance: null,
        volumeSpike: null,
        patterns: [],
        candlesCount: 0,
      };
    }

    const highs = candles.map(c => c[2]);
    const lows = candles.map(c => c[3]);
    const closes = candles.map(c => c[4]);
    const volumes = candles.map(c => c[5]);
    const currentPrice = closes[closes.length - 1];

    // RSI(14)
    const rsiResult = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiResult.length > 0 ? parseFloat(rsiResult[rsiResult.length - 1].toFixed(2)) : null;

    // EMA(20) и EMA(50)
    const ema20Result = EMA.calculate({ values: closes, period: 20 });
    const ema50Result = EMA.calculate({ values: closes, period: 50 });
    const ema20 = ema20Result.length > 0 ? parseFloat(ema20Result[ema20Result.length - 1].toFixed(6)) : null;
    const ema50 = ema50Result.length > 0 ? parseFloat(ema50Result[ema50Result.length - 1].toFixed(6)) : null;

    // Определение тренда
    let trend = 'Neutral';
    if (ema20 !== null && ema50 !== null) {
      if (ema20 > ema50) trend = 'Bullish (EMA20 > EMA50)';
      else if (ema20 < ema50) trend = 'Bearish (EMA20 < EMA50)';
    }

    // Support / Resistance по 20 последним свечам
    const recentLimit = Math.min(20, highs.length);
    const recentHighs = highs.slice(-recentLimit);
    const recentLows = lows.slice(-recentLimit);
    const resistance = Math.max(...recentHighs);
    const support = Math.min(...recentLows);

    // Volume Spike (отношение объема последней свечи к среднему за предыдущие свечи)
    let volumeSpike = null;
    if (volumes.length >= 6) {
      const currentVol = volumes[volumes.length - 1];
      const prevVols = volumes.slice(-21, -1);
      const avgVol = prevVols.reduce((a, b) => a + b, 0) / prevVols.length;
      if (avgVol > 0) {
        volumeSpike = parseFloat((currentVol / avgVol).toFixed(2));
      }
    }

    const patterns = detectCandlestickPatterns(candles, {
      trend,
      support,
      resistance,
    });

    return {
      timeframe: timeframeLabel,
      currentPrice,
      rsi,
      ema20,
      ema50,
      trend,
      support,
      resistance,
      volumeSpike,
      patterns,
      candlesCount: candles.length,
    };
  }

  /**
   * Полный технический анализ по 4 таймфреймам: 30m, 1h, 4h, 1w (100-500 свечей каждый)
   * 
   * @param {string} chain - Сеть ('solana', 'eth', 'bsc', 'ton', etc.)
   * @param {string} tokenAddress - Адрес токена
   * @param {string} [knownPairAddress] - Известный адрес пула/пары (опционально)
   * @returns {Promise<MultiTimeframeResult>}
   */
  async analyzeTokenTechnicalAnalysis(chain, tokenAddress, knownPairAddress = null) {
    const network = normalizeGeckoNetwork(chain);
    if (!network || !tokenAddress) {
      return {
        poolAddress: '',
        network: chain,
        timeframes: {},
        overallTrend: 'Neutral',
        error: 'Не указана сеть или адрес токена',
      };
    }

    let poolAddress = knownPairAddress;
    if (!poolAddress) {
      poolAddress = await this.getPoolAddress(network, tokenAddress);
    }

    if (!poolAddress) {
      return {
        poolAddress: '',
        network,
        timeframes: {},
        overallTrend: 'Neutral',
        error: `Не найден пул ликвидности в GeckoTerminal для ${network}:${tokenAddress}`,
      };
    }

    const timeframes = {};

    // 1. Таймфрейм 30m (minute/15, aggregate=15, 200 свечей = 100 свечей по 30 мин после парной агрегации)
    try {
      const raw30m = await this.fetchOhlcvCandles(network, poolAddress, 'minute', 15, 200);
      // Агрегируем каждые 2 свечи по 15м в одну 30м свечу
      const candles30m = [];
      for (let i = 0; i < raw30m.length; i += 2) {
        if (i + 1 < raw30m.length) {
          const c1 = raw30m[i];
          const c2 = raw30m[i + 1];
          candles30m.push([
            c1[0],                          // timestamp
            c1[1],                          // open
            Math.max(c1[2], c2[2]),        // high
            Math.min(c1[3], c2[3]),        // low
            c2[4],                          // close
            c1[5] + c2[5]                   // volume
          ]);
        } else {
          candles30m.push(raw30m[i]);
        }
      }
      timeframes['30m'] = this.calculateTAFromCandles(candles30m, '30m');
    } catch (err) {
      console.warn(`⚠️ Error fetching 30m OHLCV: ${err.message}`);
    }

    // 2. Таймфрейм 1h (hour/1, aggregate=1, 200 свечей)
    try {
      const raw1h = await this.fetchOhlcvCandles(network, poolAddress, 'hour', 1, 200);
      timeframes['1h'] = this.calculateTAFromCandles(raw1h, '1h');
    } catch (err) {
      console.warn(`⚠️ Error fetching 1h OHLCV: ${err.message}`);
    }

    // 3. Таймфрейм 4h (hour/4, aggregate=4, 200 свечей)
    try {
      const raw4h = await this.fetchOhlcvCandles(network, poolAddress, 'hour', 4, 200);
      timeframes['4h'] = this.calculateTAFromCandles(raw4h, '4h');
    } catch (err) {
      console.warn(`⚠️ Error fetching 4h OHLCV: ${err.message}`);
    }

    // 4. Таймфрейм 1w (day/1, 350 свечей, агрегация по 7 дней в 1 неделю)
    try {
      const raw1d = await this.fetchOhlcvCandles(network, poolAddress, 'day', 1, 350);
      const candles1w = [];
      for (let i = 0; i < raw1d.length; i += 7) {
        const chunk = raw1d.slice(i, i + 7);
        if (chunk.length > 0) {
          const open = chunk[0][1];
          const close = chunk[chunk.length - 1][4];
          const high = Math.max(...chunk.map(c => c[2]));
          const low = Math.min(...chunk.map(c => c[3]));
          const volume = chunk.reduce((sum, c) => sum + c[5], 0);
          candles1w.push([chunk[0][0], open, high, low, close, volume]);
        }
      }
      timeframes['1w'] = this.calculateTAFromCandles(candles1w, '1w');
    } catch (err) {
      console.warn(`⚠️ Error fetching 1w OHLCV: ${err.message}`);
    }

    // Определение суммарного тренда
    let bullishCount = 0;
    let bearishCount = 0;
    Object.values(timeframes).forEach(ta => {
      if (ta.trend.includes('Bullish')) bullishCount++;
      if (ta.trend.includes('Bearish')) bearishCount++;
    });

    let overallTrend = 'Neutral';
    if (bullishCount > bearishCount) overallTrend = 'Bullish';
    else if (bearishCount > bullishCount) overallTrend = 'Bearish';

    return {
      poolAddress,
      network,
      timeframes,
      overallTrend,
      error: Object.keys(timeframes).length === 0 ? 'Не удалось загрузить ни один таймфрейм' : null,
    };
  }
}
