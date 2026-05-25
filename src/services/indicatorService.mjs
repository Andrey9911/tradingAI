/**
 * Технические индикаторы по рядам цен / OHLCV (детерминированно).
 */

export function ema(values, period) {
  if (!values?.length || period < 1) return null;
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

export function rsiWilder(closes, period = 14) {
  if (!closes?.length || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gains += ch;
    else losses -= ch;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atrWilder(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period + 1 || highs.length !== n || lows.length !== n) return null;
  const tr = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr.push(highs[i] - lows[i]);
    } else {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      tr.push(Math.max(hl, hc, lc));
    }
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let atrVal = sum / period;
  for (let i = period; i < tr.length; i++) {
    atrVal = (atrVal * (period - 1) + tr[i]) / period;
  }
  return atrVal;
}

/** Последний бар / среднее предыдущих */
export function volumeSpikeRatio(volumes) {
  if (!volumes?.length || volumes.length < 6) return null;
  const current = volumes[volumes.length - 1];
  const prev = volumes.slice(0, -1);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  if (!avg || avg <= 0) return null;
  return current / avg;
}

/** Изменение цены за последние lookback закрытий (в долях, не %) */
export function momentumPct(closes, lookback = 6) {
  if (!closes?.length || closes.length <= lookback) return null;
  const a = closes[closes.length - 1 - lookback];
  const b = closes[closes.length - 1];
  if (!a || a === 0) return null;
  return ((b - a) / a) * 100;
}
