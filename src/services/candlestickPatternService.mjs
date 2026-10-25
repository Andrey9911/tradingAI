import { allPatterns, patternChain } from 'candlestick';

const SUPPORTED_PATTERN_NAMES = new Set([
  'bullishHammer',
  'bullishInvertedHammer',
  'bullishEngulfing',
  'bullishHarami',
  'morningStar',
  'threeWhiteSoldiers',
  'piercingLine',
  'bearishHammer',
  'bearishInvertedHammer',
  'bearishEngulfing',
  'bearishHarami',
  'eveningStar',
  'threeBlackCrows',
  'darkCloudCover',
  'hangingMan',
  'shootingStar',
  'doji',
]);

const BULLISH_PATTERN_NAMES = new Set([
  'bullishHammer',
  'bullishInvertedHammer',
  'bullishEngulfing',
  'bullishHarami',
  'morningStar',
  'threeWhiteSoldiers',
  'piercingLine',
]);

const BEARISH_PATTERN_NAMES = new Set([
  'bearishHammer',
  'bearishInvertedHammer',
  'bearishEngulfing',
  'bearishHarami',
  'eveningStar',
  'threeBlackCrows',
  'darkCloudCover',
  'hangingMan',
  'shootingStar',
]);

const SUPPORTED_PATTERNS = allPatterns.filter(pattern => SUPPORTED_PATTERN_NAMES.has(pattern.name));

/**
 * @typedef {[number, number, number, number, number, number]} OhlcvCandle
 */

/**
 * @typedef {Object} CandlestickPatternContext
 * @property {string} [trend]
 * @property {number|null} [support]
 * @property {number|null} [resistance]
 * @property {number} [recentBars]
 */

/**
 * Преобразует биржевой массив OHLCV в формат, который ожидает candlestick.
 * Последняя свеча исключается, потому что на момент запроса она может быть незакрытой.
 * @param {OhlcvCandle[]} candles - Свечи в хронологическом порядке.
 * @returns {Array<{timestamp: number, open: number, high: number, low: number, close: number, volume: number}>}
 */
function normalizeCompletedCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return [];

  return candles
    .slice(0, -1)
    .map(candle => ({
      timestamp: Number(candle[0]),
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5]),
    }))
    .filter(candle =>
      Number.isFinite(candle.timestamp) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.volume) &&
      candle.high >= candle.low,
    );
}

/**
 * Определяет, находится ли цена рядом с уровнем; это подтверждает разворотный паттерн.
 * @param {number} price - Цена закрытия паттерна.
 * @param {number|null|undefined} level - Уровень поддержки или сопротивления.
 * @param {number} [maxDistancePct] - Максимальная дистанция до уровня в процентах.
 * @returns {boolean}
 */
function isNearLevel(price, level, maxDistancePct = 2) {
  if (!Number.isFinite(price) || !Number.isFinite(level) || level <= 0) return false;
  return Math.abs((price - level) / level) * 100 <= maxDistancePct;
}

/**
 * Рассчитывает отношение объёма паттерна к среднему объёму предыдущих закрытых свечей.
 * @param {Array<{volume: number}>} candles - Нормализованные закрытые свечи.
 * @param {number} patternEndIndex - Индекс последней свечи паттерна.
 * @returns {number|null}
 */
function calculatePatternVolumeRatio(candles, patternEndIndex) {
  const patternVolume = candles[patternEndIndex]?.volume;
  const previousVolumes = candles
    .slice(Math.max(0, patternEndIndex - 20), patternEndIndex)
    .map(candle => candle.volume)
    .filter(volume => Number.isFinite(volume) && volume > 0);

  if (!Number.isFinite(patternVolume) || patternVolume <= 0 || previousVolumes.length < 3) return null;
  const averageVolume = previousVolumes.reduce((sum, volume) => sum + volume, 0) / previousVolumes.length;
  return averageVolume > 0 ? Number((patternVolume / averageVolume).toFixed(2)) : null;
}

/**
 * Возвращает направленность свечного паттерна либо neutral для нерешительного паттерна.
 * @param {string} patternName - Имя паттерна библиотеки candlestick.
 * @returns {'bullish'|'bearish'|'neutral'}
 */
function getPatternBias(patternName) {
  if (BULLISH_PATTERN_NAMES.has(patternName)) return 'bullish';
  if (BEARISH_PATTERN_NAMES.has(patternName)) return 'bearish';
  return 'neutral';
}

/**
 * Находит свежие закрытые свечные паттерны и добавляет наблюдаемый контекст рынка.
 * Паттерн не является торговым сигналом: вызывающий код должен учитывать риск, ликвидность,
 * деривативы и подтверждение следующей закрытой свечой.
 * @param {OhlcvCandle[]} candles - Свечи [timestamp, open, high, low, close, volume] от старых к новым.
 * @param {CandlestickPatternContext} [context] - Тренд и уровни, вычисленные тем же таймфреймом.
 * @returns {Array<{name: string, bias: 'bullish'|'bearish'|'neutral', timestamp: number, close: number, volumeRatio: number|null, nearSupport: boolean, nearResistance: boolean, trendAligned: boolean}>}
 */
export function detectCandlestickPatterns(candles, context = {}) {
  const completedCandles = normalizeCompletedCandles(candles);
  if (completedCandles.length < 3) return [];

  const recentBars = Number.isInteger(context.recentBars) && context.recentBars > 0 ? context.recentBars : 3;
  const firstRecentIndex = Math.max(0, completedCandles.length - recentBars);
  const matches = patternChain(completedCandles, SUPPORTED_PATTERNS);
  const uniqueMatches = new Map();

  for (const match of matches) {
    const patternEndIndex = match.index + match.match.length - 1;
    if (patternEndIndex < firstRecentIndex) continue;

    const bias = getPatternBias(match.pattern);
    const close = completedCandles[patternEndIndex]?.close;
    if (!Number.isFinite(close)) continue;

    const nearSupport = isNearLevel(close, context.support);
    const nearResistance = isNearLevel(close, context.resistance);
    const trendAligned =
      (bias === 'bullish' && String(context.trend || '').includes('Bearish') && nearSupport) ||
      (bias === 'bearish' && String(context.trend || '').includes('Bullish') && nearResistance);
    const key = `${match.pattern}:${patternEndIndex}`;

    uniqueMatches.set(key, {
      name: match.pattern,
      bias,
      timestamp: completedCandles[patternEndIndex].timestamp,
      close,
      volumeRatio: calculatePatternVolumeRatio(completedCandles, patternEndIndex),
      nearSupport,
      nearResistance,
      trendAligned,
    });
  }

  return [...uniqueMatches.values()].sort((left, right) => right.timestamp - left.timestamp);
}
