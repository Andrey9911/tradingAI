import { AIService } from './aiService.mjs';
import { ema, rsiWilder, atrWilder, volumeSpikeRatio, momentumPct } from './indicatorService.mjs';

function entryZone(parsed) {
  const e = parsed.entry;
  if (e.type === 'LEVELS' && e.levels.length) {
    const mn = Math.min(...e.levels);
    const mx = Math.max(...e.levels);
    return { min: mn, max: mx };
  }
  if (e.min != null && e.max != null) return { min: e.min, max: e.max };
  if (e.min != null) return { min: e.min, max: e.max ?? e.min };
  return null;
}

function entryRef(zone) {
  return (zone.min + zone.max) / 2;
}

/**
 * @param {number} price
 * @param {{min:number,max:number}} zone
 * @param {'BUY'|'SELL'} side
 */
function entryStatusAndLate(price, zone, side) {
  let status;
  if (price >= zone.min && price <= zone.max) status = 'IN_ENTRY';
  else if (price > zone.max) status = 'ABOVE_ENTRY';
  else status = 'BELOW_ENTRY';

  let latePct = null;
  if (side === 'BUY' && status === 'ABOVE_ENTRY' && zone.max > 0) {
    latePct = ((price - zone.max) / zone.max) * 100;
  }
  if (side === 'SELL' && status === 'BELOW_ENTRY' && zone.min > 0) {
    latePct = ((zone.min - price) / zone.min) * 100;
  }
  return { status, latePct };
}

/**
 * @param {'BUY'|'SELL'} side
 * @param {number} ref
 * @param {number|null} sl
 * @param {number[]} tps
 */
function computeRR(side, ref, sl, tps) {
  const out = { tp1: null, tp2: null, tp3: null };
  if (sl == null || !tps.length) return out;
  const sorted =
    side === 'BUY' ? [...tps].sort((a, b) => a - b) : [...tps].sort((a, b) => b - a);
  const pick = sorted.slice(0, 3);

  if (side === 'BUY') {
    const risk = ref - sl;
    if (risk <= 0) return out;
    pick.forEach((tp, i) => {
      const rew = tp - ref;
      const key = i === 0 ? 'tp1' : i === 1 ? 'tp2' : 'tp3';
      if (rew > 0) out[key] = rew / risk;
    });
  } else {
    const risk = sl - ref;
    if (risk <= 0) return out;
    pick.forEach((tp, i) => {
      const rew = ref - tp;
      const key = i === 0 ? 'tp1' : i === 1 ? 'tp2' : 'tp3';
      if (rew > 0) out[key] = rew / risk;
    });
  }
  return out;
}

/**
 * @param {object} p
 * @returns {{ score: number, risk: 'Low'|'Medium'|'Medium-High'|'High' }}
 */
function deterministicScoreAndRisk(p) {
  const {
    side,
    hasSl,
    inZone,
    rr,
    rsi,
    spreadPct,
    oi1h,
    funding,
    priceAboveEma20,
    ema20AboveEma50,
    priceBelowEma20,
    ema20BelowEma50,
    entryStatus,
    momentumPct: mom,
    verdictPriceOiBearish,
    verdictPriceOiShortAccum,
    fundingHotRsi,
  } = p;

  let score = 50;

  if (inZone) score += 10;
  if (rr.tp2 != null && rr.tp2 >= 2) score += 10;

  if (side === 'BUY' && priceAboveEma20 && ema20AboveEma50) score += 10;
  if (side === 'SELL' && priceBelowEma20 && ema20BelowEma50) score += 10;

  if (mom != null && oi1h != null && mom > 0 && oi1h > 0) score += 8;
  if (funding != null && funding < 0 && oi1h != null && oi1h > 0 && mom != null && mom >= -0.5) {
    score += 8;
  }

  if (spreadPct != null && spreadPct <= 0.05) score += 4;
  if (rsi != null && rsi >= 45 && rsi <= 65) score += 5;

  if (!hasSl) score -= 25;
  if (side === 'BUY' && entryStatus === 'ABOVE_ENTRY') score -= 12;
  if (side === 'SELL' && entryStatus === 'BELOW_ENTRY') score -= 12;

  if (rr.tp1 != null && rr.tp1 < 1) score -= 15;
  if (rsi != null && rsi > 75) score -= 12;
  if (side === 'BUY' && priceBelowEma20 && ema20BelowEma50) score -= 12;
  if (side === 'SELL' && priceAboveEma20 && ema20AboveEma50) score -= 12;

  if (verdictPriceOiBearish) score -= 8;
  if (verdictPriceOiShortAccum) score -= 10;
  if (fundingHotRsi) score -= 10;

  if (spreadPct != null && spreadPct > 0.2) score -= 15;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let risk = 'Medium';
  if (!hasSl || (spreadPct != null && spreadPct > 0.2) || score < 40) risk = 'High';
  else if (score < 55) risk = 'Medium-High';
  else if (score >= 75 && hasSl && rr.tp1 != null && rr.tp1 >= 1) risk = 'Low';
  else if (score < 62 || (rsi != null && rsi > 72)) risk = 'Medium-High';

  return { score, risk };
}

function verdictFromScore(score) {
  if (score >= 75) return 'BUY';
  if (score >= 55) return 'WAIT';
  return 'AVOID';
}

export class SignalAnalysisService {
  /**
   * @param {import('./bybitService.mjs').BybitService} bybit
   * @param {AIService} [ai]
   */
  constructor(bybit, ai = new AIService()) {
    this.bybit = bybit;
    this.ai = ai;
  }

  /**
   * @param {object} parsed — результат signalParserService
   * @param {{ sourceTitle: string|null, sourceType: 'forward'|'paste' }} meta
   */
  async analyze(parsed, meta) {
    const userWarnings = [];
    for (const w of parsed.warnings || []) {
      if (w && w !== 'NO_STOP_LOSS') userWarnings.push(String(w));
    }
    const symbolNormalized = parsed.symbol;

    const info = await this.bybit.getInstrumentInfo(symbolNormalized, 'spot');
    const instrumentValid = Boolean(info);

    if (!instrumentValid) {
      userWarnings.push('Пара не найдена на Bybit spot или не в статусе Trading.');
      return this.#minimalErrorAnalysis(parsed, meta, userWarnings);
    }

    const zone = entryZone(parsed);
    if (!zone) {
      userWarnings.push('Не удалось определить зону входа (entry).');
      return this.#minimalErrorAnalysis(parsed, meta, userWarnings);
    }

    const ref = entryRef(zone);
    const ticker = await this.bybit.getTicker(symbolNormalized, 'spot');
    const currentPrice =
      ticker?.lastPrice ?? (await this.bybit.getCurrentPrice(symbolNormalized));
    if (currentPrice == null || !Number.isFinite(currentPrice)) {
      userWarnings.push('Не удалось получить текущую цену.');
      return this.#minimalErrorAnalysis(parsed, meta, userWarnings);
    }

    const { status: entryStatus, latePct: entryLatePct } = entryStatusAndLate(
      currentPrice,
      zone,
      parsed.side,
    );

    const klines = await this.bybit.getKlines(symbolNormalized, '60', 100);
    const closes = klines.map(k => k.c);
    const highs = klines.map(k => k.h);
    const lows = klines.map(k => k.l);
    const volumes = klines.map(k => k.v);

    const rsi1h = closes.length >= 16 ? rsiWilder(closes, 14) : null;
    const ema20_1h = ema(closes, 20);
    const ema50_1h = ema(closes, 50);
    const atr14_1h =
      highs.length === closes.length ? atrWilder(highs, lows, closes, 14) : null;
    const volSpike = volumeSpikeRatio(volumes);
    const mom = momentumPct(closes, 6);

    const spreadPct = await this.bybit.getBidAskSpreadPct(symbolNormalized);
    const der = await this.bybit.getExtendedDerivativesContext(symbolNormalized);

    const hasSl = parsed.stopLoss != null;
    const rr = computeRR(parsed.side, ref, parsed.stopLoss, parsed.takeProfits);

    const priceAboveEma20 = ema20_1h != null && currentPrice > ema20_1h;
    const ema20AboveEma50 = ema20_1h != null && ema50_1h != null && ema20_1h > ema50_1h;
    const priceBelowEma20 = ema20_1h != null && currentPrice < ema20_1h;
    const ema20BelowEma50 = ema20_1h != null && ema50_1h != null && ema20_1h < ema50_1h;

    const inZone = entryStatus === 'IN_ENTRY';

    const oi1h = der.oiChange1h;
    const funding = der.fundingRate;
    const momVal = mom ?? 0;
    const verdictPriceOiBearish = momVal > 0 && oi1h != null && oi1h < 0;
    const verdictPriceOiShortAccum = momVal < 0 && oi1h != null && oi1h > 0;
    const fundingHotRsi =
      funding != null && funding > 0.02 && rsi1h != null && rsi1h > 68;

    const { score, risk } = deterministicScoreAndRisk({
      side: parsed.side,
      hasSl,
      inZone,
      rr,
      rsi: rsi1h,
      spreadPct,
      oi1h,
      funding,
      priceAboveEma20,
      ema20AboveEma50,
      priceBelowEma20,
      ema20BelowEma50,
      entryStatus,
      momentumPct: mom,
      verdictPriceOiBearish,
      verdictPriceOiShortAccum,
      fundingHotRsi,
    });

    let verdict = verdictFromScore(score);
    if (!hasSl && verdict === 'BUY') verdict = 'WAIT';
    if (!hasSl) {
      userWarnings.push('В посте нет SL — вердикт BUY недопустим, показан WAIT или хуже.');
    }

    const spotOrderAllowed =
      instrumentValid && parsed.marketType === 'SPOT' && parsed.side === 'BUY';

    if (parsed.marketType === 'FUTURES' || parsed.side === 'SELL') {
      userWarnings.push(
        parsed.marketType === 'FUTURES'
          ? 'FUTURES: только анализ, спот-ордер недоступен.'
          : 'SHORT/SELL: только анализ на споте, ордер не предлагается.',
      );
    }

    const change24h = ticker?.price24hPcnt ?? (await this.bybit.get24hChange(symbolNormalized));
    const volume24h = ticker?.volume24h ?? (await this.bybit.get24hVolume(symbolNormalized));
    const turnover24h = ticker?.turnover24h ?? 0;

    const snapshot = {
      currentPrice,
      change24h,
      volume24h,
      turnover24h,
      rsi1h,
      ema20_1h,
      ema50_1h,
      atr14_1h,
      volumeSpike: volSpike,
      spreadPct,
      oiChange1h: der.oiChange1h,
      oiChange4h: der.oiChange4h,
      oiChange24h: der.oiChange24h,
      fundingRate: der.fundingRate,
      longShortRatio: der.longShortRatio,
      momentum1hPct: mom,
      rawJson: { zone, ref, klinesTail: klines.slice(-3) },
    };

    const aiReason = await this.ai.explainSignalAnalysisNarrative({
      symbol: symbolNormalized,
      side: parsed.side,
      verdict,
      score,
      risk,
      entryStatus,
      rsi: rsi1h,
      funding,
      oi1h,
      spreadPct,
      rr,
      hasSl,
    });

    const aiAdvice = this.#shortAdvice(verdict, entryStatus, parsed.side, rsi1h, hasSl);

    return {
      parsed,
      symbolNormalized,
      instrumentValid,
      sourceTitle: meta.sourceTitle,
      sourceType: meta.sourceType,
      currentPrice,
      entryStatus,
      entryLatePct,
      rr,
      score,
      verdict,
      risk,
      aiReason,
      aiAdvice,
      snapshot,
      spotOrderAllowed,
      userWarnings,
    };
  }

  #shortAdvice(verdict, entryStatus, side, rsi, hasSl) {
    if (!hasSl) return 'Задайте свой SL перед реальной сделкой.';
    if (verdict === 'AVOID') return 'Лучше пропустить вход по текущим метрикам.';
    if (verdict === 'BUY' && entryStatus === 'IN_ENTRY') return 'Зона входа совпадает с рынком — следите за объёмом и новостями.';
    if (verdict === 'WAIT' && side === 'BUY' && entryStatus === 'ABOVE_ENTRY') {
      return 'Не входить сейчас; разумнее ждать ретест зоны входа или снижения перегрева.';
    }
    if (rsi != null && rsi > 70) return 'RSI высокий — осторожно с агрессивным входом.';
    return 'Сопоставьте сигнал с вашим риск-менеджментом.';
  }

  #minimalErrorAnalysis(parsed, meta, userWarnings) {
    return {
      parsed,
      symbolNormalized: parsed.symbol,
      instrumentValid: false,
      sourceTitle: meta.sourceTitle,
      sourceType: meta.sourceType,
      currentPrice: 0,
      entryStatus: 'BELOW_ENTRY',
      entryLatePct: null,
      rr: { tp1: null, tp2: null, tp3: null },
      score: 0,
      verdict: 'AVOID',
      risk: 'High',
      aiReason: 'Недостаточно данных для анализа.',
      aiAdvice: userWarnings[0] || 'Проверьте текст сигнала и тикер.',
      snapshot: {
        currentPrice: 0,
        change24h: 0,
        volume24h: 0,
        turnover24h: 0,
        rsi1h: null,
        ema20_1h: null,
        ema50_1h: null,
        atr14_1h: null,
        volumeSpike: null,
        spreadPct: null,
        oiChange1h: null,
        oiChange4h: null,
        oiChange24h: null,
        fundingRate: null,
        longShortRatio: null,
        momentum1hPct: null,
        rawJson: {},
      },
      spotOrderAllowed: false,
      userWarnings,
    };
  }
}
