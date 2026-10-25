import { AuthService } from '../services/authService.mjs';
import { BybitService, getLiquidityLine } from '../services/bybitService.mjs';
import { AIService } from '../services/aiService.mjs';
import { InlineKeyboard } from 'grammy';
import { getNewsSentiment } from '../services/searchNews/searchNews.mjs';
import { TokenDiscoveryService } from '../services/tokenDiscoveryService.mjs';
import { WalletIntelService } from '../services/walletIntelService.mjs';
import { GeckoOhlcvService } from '../services/geckoOhlcvService.mjs';
import { getTopTrades } from '../services/topTradesService.mjs';
import ccxt from 'ccxt';
import { RSI, EMA } from 'technicalindicators';

const DEFAULT_SIGNAL_SETTINGS = {
  /** спред для сигнала на продажу (>= %) */
  sellSpreadPct: parseFloat(process.env.SIGNAL_SELL_SPREAD_PCT || '5'),
  /** Не предлагать вход, если рост за 24ч выше (%) — «на пике» */
  maxEntryChg24Pct: parseFloat(process.env.SIGNAL_MAX_ENTRY_CHG24_PCT || '15'),
  /** Не рассматривать «покупку» по монетам, где позиция крупнее (USDT) */
  holdSkipUsd: parseFloat(process.env.SIGNAL_HOLD_SKIP_USD || '10'),
};

const STABLE_BASE = new Set([
  'USDT',
  'USDC',
  'USDD',
  'DAI',
  'TUSD',
  'FDUSD',
  'BUSD',
]);
const NATIVE_COINS = [
  "BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "AVAX", "TRX", "DOT", "LINK",
  "SUI", "APT", "NEAR", "TON", "ATOM", "LTC", "BCH", "XLM", "ALGO", "ICP",
  "FIL", "ETC", "XMR", "HBAR", "VET", "KAS", "SEI", "TIA", "INJ", "FTM",
  "POL", "ARB", "OP", "STRK", "MANTA", "METIS", "RON", "SMR", "CORE", "KLAY","ENA","PEPE","ZEC"
];


/**
 * Функция для определения типа актива
 * @param {string} inputTicker - Тикер от пользователя (например, ' btc ', 'ETH', 'pepe')
 * @returns {string} - Строка 'натив' или 'токен'
 */
export function getAssetType(inputTicker) {
  if (!inputTicker) return "токен"; // Защита от пустого ввода

  // Очищаем от пробелов и приводим к верхнему регистру (btc -> BTC)
  const cleanTicker = inputTicker.trim().toUpperCase();

  // Проверяем, есть ли тикер в нашем массиве нативных монет
  if (NATIVE_COINS.includes(cleanTicker)) {
    return "native";
  } else {
    return "token";
  }
}

function resolveAnalysisRoute(inputTicker, isAddress) {
  if (isAddress) return 'DEX_ONLY';
  const normalized = String(inputTicker || '').trim().toUpperCase().replace(/\/USDT$/, '').replace(/USDT$/, '');
  return getAssetType(normalized) === 'native' ? 'CEX_ONLY' : 'DEX_DISCOVERY';
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

}


/** RSI(14) по ряду закрытий (от старых к новым) */
export function computeRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += -change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Единый переиспользуемый экземпляр CCXT Bybit с увеличенным таймаутом (30 сек) и встроенным ограничением запросов */
const bybitCcxtExchange = new ccxt.bybit({
  timeout: 50000,
  enableRateLimit: true,
});

/**
 * Получение исторических данных и расчет базового технического анализа
 * @param {string} ticker - Тикер монеты (например, 'ENJ')
 * @param {string} timeframe - Таймфрейм свечей (по умолчанию '4h')
 * @param {number} limit - Количество свечей
 * @returns {Promise<Object>} Данные технического анализа или объект ошибки
 */
export async function getTechnicalAnalysis(ticker, timeframe = '4h', limit = 200) {
  try {
    const exchange = bybitCcxtExchange;
    const baseTicker = ticker.toUpperCase().replace(/USDT$/, '');
    const symbol = `${baseTicker}/USDT`;

    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

    if (!ohlcv || ohlcv.length === 0) {
      return { error: 'Нет данных OHLCV' };
    }

    const highs = ohlcv.map(candle => candle[2]);
    const lows = ohlcv.map(candle => candle[3]);
    const closes = ohlcv.map(candle => candle[4]);
    const currentPrice = closes[closes.length - 1];

    const rsiResult = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : null;

    const ema20Result = EMA.calculate({ values: closes, period: 20 });
    const ema50Result = EMA.calculate({ values: closes, period: 50 });
    const ema20 = ema20Result.length > 0 ? ema20Result[ema20Result.length - 1] : null;
    const ema50 = ema50Result.length > 0 ? ema50Result[ema50Result.length - 1] : null;

    let trend = 'Neutral';
    if (ema20 && ema50) {
      if (ema20 > ema50) trend = 'Bullish (EMA20 > EMA50)';
      else if (ema20 < ema50) trend = 'Bearish (EMA20 < EMA50)';
    }

    const recentLimit = 20;
    const recentHighs = highs.slice(-recentLimit);
    const recentLows = lows.slice(-recentLimit);
    
    const resistance = Math.max(...recentHighs);
    const support = Math.min(...recentLows);

    return {
      timeframe,
      rsi: rsi ? parseFloat(rsi.toFixed(2)) : null,
      trend,
      ema20: ema20 ? parseFloat(ema20.toFixed(4)) : null,
      ema50: ema50 ? parseFloat(ema50.toFixed(4)) : null,
      support,
      resistance,
      currentPrice
    };
  } catch (err) {
    console.error(`Ошибка в getTechnicalAnalysis для ${ticker}:`, err.message);
    return { error: 'Не удалось рассчитать ТА' };
  }
}

export async function getBtcCorrelation(ticker, timeframe = '1h', period = 100) {
  try {
    const tokenBase = String(ticker || '').toUpperCase().replace(/USDT$/, '');
    if (!tokenBase || tokenBase === 'BTC') return null;
    const [btcCandles, tokenCandles] = await Promise.all([
      bybitCcxtExchange.fetchOHLCV('BTC/USDT', timeframe, undefined, period),
      bybitCcxtExchange.fetchOHLCV(`${tokenBase}/USDT`, timeframe, undefined, period),
    ]);
    const btcMap = new Map((btcCandles || []).map(c => [Number(c[0]), Number(c[4])]));
    const tokenMap = new Map((tokenCandles || []).map(c => [Number(c[0]), Number(c[4])]));
    const timestamps = [...btcMap.keys()].filter(ts => tokenMap.has(ts)).sort((a, b) => a - b);
    const btcCloses = timestamps.map(ts => btcMap.get(ts));
    const tokenCloses = timestamps.map(ts => tokenMap.get(ts));
    const btcReturns = [];
    const tokenReturns = [];
    for (let i = 1; i < timestamps.length; i += 1) {
      if (btcCloses[i - 1] <= 0 || tokenCloses[i - 1] <= 0) continue;
      const btcReturn = btcCloses[i] / btcCloses[i - 1] - 1;
      const tokenReturn = tokenCloses[i] / tokenCloses[i - 1] - 1;
      if (Number.isFinite(btcReturn) && Number.isFinite(tokenReturn)) {
        btcReturns.push(btcReturn);
        tokenReturns.push(tokenReturn);
      }
    }
    if (btcReturns.length < 3) return null;
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    const btcMean = mean(btcReturns);
    const tokenMean = mean(tokenReturns);
    let covariance = 0;
    let btcVariance = 0;
    let tokenVariance = 0;
    for (let i = 0; i < btcReturns.length; i += 1) {
      const btcDelta = btcReturns[i] - btcMean;
      const tokenDelta = tokenReturns[i] - tokenMean;
      covariance += btcDelta * tokenDelta;
      btcVariance += btcDelta ** 2;
      tokenVariance += tokenDelta ** 2;
    }
    const denominator = Math.sqrt(btcVariance * tokenVariance);
    const pearson = denominator > 0 ? covariance / denominator : 0;
    const beta = btcVariance > 0 ? covariance / btcVariance : 0;
    const changePct = (closes, bars) => closes.length > bars && closes.at(-1 - bars) > 0
      ? ((closes.at(-1) / closes.at(-1 - bars)) - 1) * 100
      : null;
    const ema20 = EMA.calculate({ values: btcCloses, period: 20 });
    const ema50 = EMA.calculate({ values: btcCloses, period: 50 });
    const btcTrend = ema20.length && ema50.length
      ? (ema20.at(-1) > ema50.at(-1) ? 'BULLISH' : ema20.at(-1) < ema50.at(-1) ? 'BEARISH' : 'NEUTRAL')
      : 'NEUTRAL';
    const regime = pearson >= 0.70 ? 'BTC_HIGH_CORRELATION' : pearson >= 0.40 ? 'BTC_MEDIUM_CORRELATION' : 'BTC_LOW_CORRELATION';
    const roundedChange = (closes, bars) => {
      const value = changePct(closes, bars);
      return value == null ? null : Number(value.toFixed(4));
    };
    return {
      timeframe,
      period,
      pearson: Number(pearson.toFixed(4)),
      beta: Number(beta.toFixed(4)),
      btcChange1h: roundedChange(btcCloses, 1),
      btcChange4h: roundedChange(btcCloses, 4),
      btcChange24h: roundedChange(btcCloses, 24),
      tokenChange1h: roundedChange(tokenCloses, 1),
      tokenChange4h: roundedChange(tokenCloses, 4),
      tokenChange24h: roundedChange(tokenCloses, 24),
      regime,
      btcTrend,
    };
  } catch (err) {
    console.warn(`BTC correlation unavailable for ${ticker}:`, err.message);
    return null;
  }
}

function baseCoinFromSpotSymbol(symbol) {
  if (!symbol.endsWith('USDT')) return null;
  return symbol.slice(0, -4);
}

function shouldIncludeForBuyScan(symbol, balances, holdSkipUsd) {
  const base = baseCoinFromSpotSymbol(symbol);
  if (!base || STABLE_BASE.has(base)) return false;
  const row = balances.find(b => b.coin === base);
  if (!row) return true;
  const usd = row.usdValue ?? 0;
  return usd < holdSkipUsd;
}

function getSignalSettings(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.signalSettings) ctx.session.signalSettings = { ...DEFAULT_SIGNAL_SETTINGS };
  // Подмешиваем значения из env, если ключей не хватает.
  ctx.session.signalSettings.sellSpreadPct ??= DEFAULT_SIGNAL_SETTINGS.sellSpreadPct;
  ctx.session.signalSettings.maxEntryChg24Pct ??= DEFAULT_SIGNAL_SETTINGS.maxEntryChg24Pct;
  ctx.session.signalSettings.holdSkipUsd ??= DEFAULT_SIGNAL_SETTINGS.holdSkipUsd;
  return ctx.session.signalSettings;
}

/**
 * Поиск сигналов: продажа по портфелю + ИИ по топ-ликвидным парам без крупной позиции
 */
export async function runSignalSearch(ctx) {
  const settings = getSignalSettings(ctx);
  const userId = ctx.from.id;
  let keys;
  // 1. Создаем начальное сообщение
  let statusText = '🔍 <b>Анализирую рынок и ваши активы...</b>\n\n';

  // Функция для живого обновления текста
  const updateStatus = async (newLine) => {
    try {
      // Добавляем новую строку в лог и держим последние 5 строк, чтобы сообщение не было бесконечным
      const lines = statusText.split('\n');
      lines.push(newLine);
      statusText = lines.slice(-10).join('\n'); // Храним историю последних логов
      
      await ctx.api.editMessageText(loading.chat.id, loading.message_id, statusText, {
        parse_mode: 'HTML'
      });
    } catch (e) {
      // Игнорируем ошибки "message is not modified" от Telegram
    }
  };
  try {
    keys = await new AuthService().getUserKeys(userId);
    if (!keys) {
      await ctx.reply('❌ Вы не зарегистрированы. Используйте /register');
      return;
    }
  } catch (err) {
    await ctx.reply(`Ошибка ключей: ${err.message}`);
    return;
  }

  const bybit = new BybitService(keys.apiKey, keys.apiSecret);
  const ai = new AIService();

  const loading = await ctx.reply('⏳ Сканирую сигналы (портфель + топ объёма + ИИ)…');

  try {
    const balances = await bybit.getSpotBalances();
    const holdings = balances.filter(
      b =>
        parseFloat(b.walletBalance) > 0 &&
        !['USDT', 'USDC', 'USD'].includes(b.coin),
    );

    /** @type {Array<{ coin: string, spread: number, refPrice: number, refSource: string, currentPrice: number, usdValue: number, change24h: number, avg3?: number, spreadAvg3?: number }>} */
    const sellSignals = [];

    for (const asset of holdings) {
      const symbol = `${asset.coin}USDT`;
      const buys = await bybit.getBuyExecutions(asset.coin, 50);
      if (!buys.length) continue;

      const lastBuy = parseFloat(buys[0].execPrice);
      let refPrice = lastBuy;
      let refSource = 'last';
      if (!Number.isFinite(lastBuy) || lastBuy <= 0) {
        if (buys.length >= 3) {
          refPrice =
            buys.slice(0, 3).reduce((s, b) => s + parseFloat(b.execPrice), 0) /
            3;
          refSource = 'avg3';
        } else {
          refPrice =
            buys.reduce((s, b) => s + parseFloat(b.execPrice), 0) / buys.length;
          refSource = 'avg_n';
        }
      }

      const currentPrice = await bybit.getCurrentPrice(symbol);
      if (!currentPrice || !Number.isFinite(refPrice) || refPrice <= 0) continue;

      const spread = ((currentPrice - refPrice) / refPrice) * 100;
      let avg3;
      if (buys.length >= 3) {
        avg3 =
          buys.slice(0, 3).reduce((s, b) => s + parseFloat(b.execPrice), 0) / 3;
      }
      const spreadAvg3 =
        avg3 && Number.isFinite(avg3) && avg3 > 0
          ? ((currentPrice - avg3) / avg3) * 100
          : null;

      const sellHit =
        spread >= settings.sellSpreadPct ||
        (spreadAvg3 != null && spreadAvg3 >= settings.sellSpreadPct);
      if (!sellHit) continue;

      sellSignals.push({
        coin: asset.coin,
        spread,
        refPrice,
        refSource,
        currentPrice,
        usdValue: asset.usdValue ?? 0,
        change24h: asset.change24h ?? 0,
        avg3: avg3 && Number.isFinite(avg3) ? avg3 : undefined,
        spreadAvg3: spreadAvg3 != null ? spreadAvg3 : undefined,
      });
    }

    const tickers = await bybit.getSpotUsdtTickers();
    const byTurnover = [...tickers].sort(
      (a, b) =>
        parseFloat(b.turnover24h || '0') - parseFloat(a.turnover24h || '0'),
    );

    /** @type {Array<{ symbol: string, verdict: string, reason: string, rsi14: number|null, spreadPct: number|null, change24h: number, turnover24h: string }>} */
    const buyRows = [];

    for (const t of byTurnover) {
      // Обновляем статус: поиск продолжается
      const sym = t.symbol;
      await updateStatus(`⏳ Анализирую <b>${sym}</b>... поиск продолжается`);

      if (buyRows.length >= 10) break;
      
      const base = baseCoinFromSpotSymbol(sym);
      if (!base || STABLE_BASE.has(base)) continue;

      const chg = parseFloat(t.price24hPcnt || '0') * 100;
      if (chg > settings.maxEntryChg24Pct) continue;

      if (!shouldIncludeForBuyScan(sym, balances, settings.holdSkipUsd)) continue;

      // --- НОВЫЕ МЕТРИКИ ---
      // Получаем свечи и всплеск объема
      const { closes, volumeSpike } = await bybit.getKlineHourlyData(sym, 30);
      const rsi14 = computeRsi(closes, 14);
      
      const spreadPct = await bybit.getBidAskSpreadPct(sym);
      const lastPrice = parseFloat(t.lastPrice || '0');
      const turnover24h = t.turnover24h || '0';

      // Получаем деривативные метрики (OI, Funding, L/S)
      const deriv = await bybit.getDerivativesContext(sym);

      // Получаем новостной анализ для текущей монеты
      const baseCoin = baseCoinFromSpotSymbol(sym); // у вас уже есть эта функция
      const newsSentiment = await getNewsSentiment(baseCoin);
      await updateStatus(`📰 Анализ новостей для ${sym}: ${newsSentiment?.overall || 'нет данных'}`);

      const verdict = await ai.evaluateEntrySignal({
        symbol: sym,
        lastPrice,
        change24h: chg,
        volume24h: t.volume24h,
        turnover24h,
        rsi14,
        spreadPct,
        closes,
        // Добавляем новые метрики в объект:
        fundingRate: deriv.fundingRate,
        oiChangePct: deriv.oiChangePct,
        lsRatio: deriv.lsRatio,
        volumeSpike: volumeSpike,
        newsSentiment: newsSentiment,   // ← добавлено
      },updateStatus);

      buyRows.push({
        symbol: sym,
        verdict: verdict.verdict,
        reason: verdict.reason,
        rsi14,
        spreadPct,
        change24h: chg,
        turnover24h,
        oiChangePct: deriv.oiChangePct,
        fundingRate: deriv.fundingRate
      });
    }
    

    // Создаем клавиатуру для покупок
    const buyKeyboard = new InlineKeyboard();
    let hasBuyButtons = false;

    let text = `<b>🔍 Поиск сигналов</b>\n`;
    text += `<i>Продажа: спред ≥ ${settings.sellSpreadPct}% к цене покупки (последняя или средняя 3 сделок). Вход: топ по объёму, 24ч ≤ +${settings.maxEntryChg24Pct}%, без крупной позиции (&gt; ${settings.holdSkipUsd} USDT).</i>\n\n`;

    text += `<b>📈 Сигналы на продажу</b>\n`;
    if (!sellSignals.length) {
      text += 'Нет активов с ростом от базы покупки выше порога.\n\n';
    } else {
      sellSignals.forEach(r => {
        text += `• <b>${escapeHtml(r.coin)}</b> +${r.spread.toFixed(2)}%`;
        text += ` <i>(база: ${escapeHtml(r.refSource)}, ${r.refPrice})</i>\n`;
        text += `  сейчас ${r.currentPrice}, ~${r.usdValue.toFixed(2)} USDT, 24ч ${r.change24h.toFixed(2)}%\n`;

        text += `  <blockquote>24ч ${r.change24h.toFixed(2)}%\n RSI≈${r.rsi14 != null ? r.rsi14.toFixed(1) : '—'}\n OI Изм: ${r.oiChangePct != null ? r.oiChangePct.toFixed(2) + '%' : '—'}\n Фандинг: ${r.fundingRate != null ? r.fundingRate.toFixed(4) + '%' : '—'}</blockquote>\n`;
        if (r.avg3 != null && r.spreadAvg3 != null) {
          text += `  средняя 3 покупок: ${r.avg3.toFixed(8)} → спред ${r.spreadAvg3 >= 0 ? '+' : ''}${r.spreadAvg3.toFixed(2)}%\n`;
        }
        text += '\n';
      });
      
    }

    text += `<b>📉 Идеи на покупку (ИИ + метрики)</b>\n`;
    if (!buyRows.length) {
      text += 'Нет подходящих пар после фильтров.\n';
    } else {
      buyRows.forEach(r => {
        const isBuy = r.verdict === 'BUY';
        const tag =
          r.verdict === 'BUY'
            ? '🟢 BUY'
            : r.verdict === 'AVOID'
              ? '🔴 AVOID'
              : '🟡 WAIT';
        text += `• <b>${escapeHtml(r.symbol)}</b> ${tag}`;
        text += `  <blockquote>24ч ${r.change24h.toFixed(2)}%\n RSI≈${r.rsi14 != null ? r.rsi14.toFixed(1) : '—'}\n OI Изм: ${r.oiChangePct != null ? r.oiChangePct.toFixed(2) + '%' : '—'}\n Фандинг: ${r.fundingRate != null ? r.fundingRate.toFixed(4) + '%' : '—'}</blockquote>\n`;        text += `  <i>${escapeHtml(r.reason)}</i>\n`;
        // Если ИИ сказал BUY, добавляем кнопку
        if (isBuy) {
          // callback_data ограничен 64 байтами, поэтому делаем короткий ключ 'buy_ai_SYMBOL'
          buyKeyboard.text(`🛒 Купить ${r.symbol}`, `buy_ai_${r.symbol}`).row();
          hasBuyButtons = true;
        }
      });
      text += `\n`;
    }
    text += `\n\n`;

    await ctx.api
      .deleteMessage(loading.chat.id, loading.message_id)
      .catch(() => {});

    const chunks = chunkHtmlMessage(text, 4000);
    for (let i = 0; i < chunks.length; i++) {
      const options = { parse_mode: 'HTML' };

      // Если это ПОСЛЕДНИЙ кусок сообщения
      if (i === chunks.length - 1) {
        // 1. Финально подготавливаем клавиатуру
        if (hasBuyButtons) {
          // Если были кнопки покупки, добавляем "Обновить" новой строкой внизу
          buyKeyboard.row().text('🔄 Обновить список', 'refresh_ai_signals');
        } else {
          // Если кнопок покупки нет, просто добавляем "Обновить"
          buyKeyboard.text('🔄 Обновить список', 'refresh_ai_signals');
        }

        // 2. ПРИКРЕПЛЯЕМ клавиатуру к сообщению (без лишних условий!)
        options.reply_markup = buyKeyboard;
      }

      // Отправляем чанк
      await ctx.reply(chunks[i], options).catch(err => {
        console.error(`Ошибка при отправке чанка ${i}:`, err);
      });
      await ctx.reply(chunks[i], options);

    }
  // В конце удаляем статусное сообщение или меняем на "Готово"
  await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
  } catch (err) {
    console.error('runSignalSearch', err);
    await ctx.api
      .deleteMessage(loading.chat.id, loading.message_id)
      .catch(() => {});
    await ctx.reply(`❌ Ошибка: ${escapeHtml(err.message)}`, {
      parse_mode: 'HTML',
    });
  }
}

function chunkHtmlMessage(html, maxLen) {
  if (html.length <= maxLen) return [html];
  const parts = [];
  let rest = html;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) parts.push(rest);
  return parts;
}

function shortAddress(address) {
  if (!address) return '—';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function compactAddress(address) {
  return address ? String(address).trim() : '';
}

function extractFeatureValue(val, fallback = 'UNKNOWN') {
  if (!val) return fallback;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.value || val.name || fallback;
  return String(val);
}

export async function runUserSignalAnalysis(ctx, ticker, description, direction = null, type_coin) {
  let keys;
  try {
    keys = await new AuthService().getUserKeys(ctx.from.id);
    if (!keys) {
      await ctx.reply('❌ Вы не зарегистрированы. Используйте /register');
      return;
    }
  } catch (err) {
    await ctx.reply(`Ошибка ключей: ${err.message}`);
    return;
  }

  const loading = await ctx.reply(`⏳ Начинаю анализ сигнала по тикеру/адресу: <b>${escapeHtml(ticker)}</b>...`, { parse_mode: 'HTML' });
  let statusText = `🔍 <b>Анализирую сигнал по ${escapeHtml(ticker)}...</b>\n\n`;

  const updateStatus = async (newLine) => {
    try {
      const lines = statusText.split('\n');
      lines.push(newLine);
      statusText = lines.slice(-10).join('\n');
      
      await ctx.api.editMessageText(loading.chat.id, loading.message_id, statusText, {
        parse_mode: 'HTML'
      });
    } catch (e) {
      // Игнорируем ошибки Telegram (например message not modified)
    }
  };

  try {
    const bybit = new BybitService(keys.apiKey, keys.apiSecret);
    const ai = new AIService();
    
    // Smart Input Resolver: detect if ticker is a contract address
    const isAddress = /^0x[a-fA-F0-9]{40}$/.test(ticker.trim()) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ticker.trim());
    const analysisRoute = resolveAnalysisRoute(ticker, isAddress);
    let resolvedTicker = ticker.trim();
    let tokenData = null;
    let searchResults = [];

    const tokenDiscovery = analysisRoute === 'CEX_ONLY' ? null : new TokenDiscoveryService();
    const walletIntel = analysisRoute === 'CEX_ONLY' ? null : new WalletIntelService();
    const geckoOhlcv = analysisRoute === 'CEX_ONLY' ? null : new GeckoOhlcvService();

    if (analysisRoute === 'DEX_ONLY') {
      if(type_coin === 'token'){

        await updateStatus('🕵️ Обнаружен контракт-адрес. Запрашиваю информацию о токене на DEX...');
        searchResults = await tokenDiscovery.fetchDexScreenerTokenByQuery(ticker, updateStatus);
        tokenData = searchResults.find(t => t.address.toLowerCase() === ticker.toLowerCase()) || searchResults[0] || null;
        if (tokenData && tokenData.symbol) {
          resolvedTicker = tokenData.symbol;
          await updateStatus(`✅ Контракт распознан как токен: <b>${escapeHtml(resolvedTicker)}</b>`);
        }
      }
    }

    // 1. Быстрый сбор метрик Bybit и Технического анализа (ПАРАЛЛЕЛЬНО)
    await updateStatus('📊 Запрашиваю рыночные данные и вычисляю технический анализ...');
    const symbol = resolvedTicker.toUpperCase().endsWith('USDT') ? resolvedTicker.toUpperCase() : `${resolvedTicker.toUpperCase()}USDT`;
    const baseTicker = baseCoinFromSpotSymbol(symbol) || resolvedTicker;
    
    const [
      currentPrice,
      klineData,
      spreadPct,
      change24h,
      volume24h,
      deriv,
      newsSentiment,
      technicalAnalysis,
      liquidityClusters,
      btcCorrelation,
      recentTrades,
      fundingHistory,
      spotInstrument,
      linearInstrument,
      technicalAnalysis1h,
      technicalAnalysis1d
    ] = await Promise.all([
      bybit.getCurrentPrice(symbol).catch(() => null),
      bybit.getKlineHourlyData(symbol, 30).catch(() => ({ closes: [], volumeSpike: 0 })),
      bybit.getBidAskSpreadPct(symbol).catch(() => null),
      bybit.get24hChange(symbol).catch(() => 0),
      bybit.get24hVolume(symbol).catch(() => 0),
      bybit.getDerivativesContext(symbol).catch(() => ({ fundingRate: null, oiChangePct: null, lsRatio: null })),
      getNewsSentiment(baseTicker).catch(() => null),
      getTechnicalAnalysis(baseTicker, '4h').catch(() => ({ error: 'Не удалось рассчитать ТА' })),
      getLiquidityLine(baseTicker).catch(() => null),
      getBtcCorrelation(baseTicker, '1h', 100).catch(() => null),
      bybit.getRecentTrades(symbol, 'spot', 100).catch(() => []),
      bybit.getFundingRateHistory(symbol, 20).catch(() => []),
      bybit.getInstrumentInfo(symbol, 'spot').catch(() => null),
      bybit.getInstrumentInfo(symbol, 'linear').catch(() => null),
      getTechnicalAnalysis(baseTicker, '1h').catch(() => ({ error: 'TA unavailable' })),
      getTechnicalAnalysis(baseTicker, '1d').catch(() => ({ error: 'TA unavailable' }))
    ]);

    const { closes, volumeSpike } = klineData || { closes: [], volumeSpike: 0 };
    const rsi14 = computeRsi(closes, 14);
    const taTimeframes = { '1h': technicalAnalysis1h, '4h': technicalAnalysis, '1d': technicalAnalysis1d };
    const completenessScore = Number(([
      Number.isFinite(currentPrice), closes.length >= 15, spreadPct != null,
      recentTrades.length > 0, deriv?.fundingRate != null || deriv?.oiChangePct != null,
    ].filter(Boolean).length / 5).toFixed(2));

    // 2. DEX Token & Wallet Intelligence + DEX OHLCV TA
    let walletData = null;
    let topTrades = [];
    let dexTechnicalAnalysis = null;

    if (analysisRoute === 'DEX_DISCOVERY') {
      await updateStatus('🕵️ Выполняю DEX поиск токена...');
      searchResults = await tokenDiscovery.fetchDexScreenerTokenByQuery(ticker, updateStatus);
      tokenData = searchResults.find(t => t.address.toLowerCase() === ticker.toLowerCase() || t.symbol.toUpperCase() === ticker.toUpperCase()) || searchResults[0] || null;
    }

    if (analysisRoute !== 'CEX_ONLY' && tokenData && type_coin === 'token') {
      await updateStatus('🧠 Собираю on-chain данные, история сделок и ТА по свечам (30m, 1h, 4h, 1w)...');
      const [walletRes, tradesRes, taRes] = await Promise.all([
        walletIntel.analyzeToken(tokenData, updateStatus).catch(() => null),
        getTopTrades(tokenData, tokenData.price || currentPrice).catch(() => []),
        geckoOhlcv.analyzeTokenTechnicalAnalysis(tokenData.chain, tokenData.address, tokenData.pairAddress).catch(() => null),
      ]);
      walletData = walletRes;
      topTrades = tradesRes;
      dexTechnicalAnalysis = taRes;
    } else if (analysisRoute !== 'CEX_ONLY') {
      await updateStatus('⚠️ Токен не найден в DEX сетях, продолжаем анализ с CEX данными.');
    }

    // 3. Aggregate data for AI
    await updateStatus('🤖 Формирую отчет с помощью нейросети...');
    
    const aggregatedData = {
      ticker: resolvedTicker,
      direction,
      description,
      market: {
        price: currentPrice || tokenData?.price,
        change24h: change24h || tokenData?.priceChange24h,
        volume24h: volume24h || tokenData?.volume24h,
        rsi14,
        spreadPct,
        volumeSpike,
      },
      technical_analysis: technicalAnalysis,
      technical_analysis_timeframes: taTimeframes,
      cex_analysis: {
        route: analysisRoute,
        exchange: 'Bybit',
        symbol,
        spotInstrument,
        linearInstrument,
        recentTrades,
        fundingHistory,
        completenessScore,
      },
      btcCorrelation,
      dex_technical_analysis: dexTechnicalAnalysis,
      liquidityClusters: liquidityClusters,
      derivatives: deriv,
      news: newsSentiment,
      onchain: tokenData && walletData ? {
        token: tokenData,
        riskLevel: walletData.riskLevel,
        features: walletData.features || [],
        fundingCluster: walletData.fundingCluster,
        sniperBehavior: walletData.sniperBehavior,
        transferPattern: walletData.transferPattern,
        holderDistribution: walletData.holderDistribution,
        walletAgeDays: walletData.walletAgeDays,
        firstFundingSource: walletData.firstFundingSource,
        connectedWallets: walletData.connectedWallets,
        previousTokens: walletData.previousTokens,
        previousRugpulls: walletData.previousRugpulls,
        devWallet: walletData.devWallet,
        realizedProfit: walletData.realizedProfit,
        knowledgeGraph: walletData.knowledgeGraph,
        summary: walletData.summary,
        topRecentTrades: topTrades
      } : null
    };

    const aiResponse = await ai.evaluateDiscoveredToken(aggregatedData, updateStatus);

    // Форматирование Whale Tracker
    const chain = String(tokenData?.chain || '').toLowerCase().trim();
    let top5List = '';
    if (topTrades && topTrades.length > 0) {
      top5List = topTrades.map(t => {
        const emoji = t.kind === 'buy' ? '🟢' : '🔴';
        const typeStr = t.kind.toUpperCase();
        const volumeStr = t.volumeUsd.toLocaleString('en-US', { maximumFractionDigits: 0 });
        
        if (chain === 'solana' || chain === 'sol') {
          const solPrice = parseFloat(process.env.SOL_PRICE_USD || '180');
          const solAmount = t.volumeUsd / solPrice;
          return `${emoji} <b>${typeStr}:</b> $${volumeStr} (${solAmount.toFixed(2)} SOL)`;
        } else if (chain === 'ton') {
          const tonPrice = 7.5;
          const tonAmount = t.volumeUsd / tonPrice;
          return `${emoji} <b>${typeStr}:</b> $${volumeStr} (${tonAmount.toFixed(2)} TON)`;
        } else if (chain === 'robinhood' || chain === 'robinhood-chain' || chain === 'rh-evm') {
          const ethPrice = 3400;
          const ethAmount = t.volumeUsd / ethPrice;
          return `${emoji} <b>${typeStr}:</b> $${volumeStr} (${ethAmount.toFixed(3)} WETH)`;
        }
        return `${emoji} <b>${typeStr}:</b> $${volumeStr}`;
      }).join('\n');
    } else {
      top5List = '<i>Транзакции не найдены</i>';
    }

    // Форматирование DEX ТА по свечам (30m, 1h, 4h, 1w)
    let dexTaReport = '';
    if (dexTechnicalAnalysis && dexTechnicalAnalysis.timeframes && Object.keys(dexTechnicalAnalysis.timeframes).length > 0) {
      dexTaReport = `<b>📈 Технический анализ по свечам (GeckoTerminal):</b>\n`;
      const tfKeys = ['30m', '1h', '4h', '1w'];
      for (const tf of tfKeys) {
        const item = dexTechnicalAnalysis.timeframes[tf];
        if (item && item.currentPrice !== null) {
          const rsiStr = item.rsi != null ? `RSI: ${item.rsi}` : 'RSI: —';
          const suppResStr = (item.support != null && item.resistance != null) ? ` | Поддержка: ${item.support} / Сопр: ${item.resistance}` : '';
          dexTaReport += `• <b>${tf}:</b> ${item.trend} | ${rsiStr}${suppResStr}\n`;
        }
      }
      dexTaReport += `\n`;
    }

    let report = 'Вердикт загружается';
    const vUpper = String(aiResponse.verdict || '').toUpperCase();
    const aiStatusEmoji = ['BUY', 'ПОКУПАТЬ', 'ПОКУПКА'].includes(vUpper) ? '🟢' : (['SELL', 'ПРОДАВАТЬ', 'ПРОДАЖА'].includes(vUpper) ? '🔴' : (['AVOID', 'ИЗБЕГАТЬ'].includes(vUpper) ? '⛔' : '🟡'));
    const aiStatusText = aiResponse.verdict;
    const fullAiVerdictText = escapeHtml(aiResponse.reason);

    if (analysisRoute !== 'CEX_ONLY' && tokenData) {
      console.log('Token Data:', tokenData);
      const addressShort = shortAddress(tokenData.address);
      const liquidityStr = tokenData.liquidityUsd ? tokenData.liquidityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '0';
      const ageMin = Math.round(tokenData.ageMinutes || 0);
      const riskLevel = walletData?.riskLevel || 'UNKNOWN';
      const pattern = extractFeatureValue(walletData?.transferPattern, 'UNKNOWN');
      const chainStr = String(tokenData.chain || '').toUpperCase();

      report = `<b>🤖 Анализ актива:</b> ${escapeHtml(tokenData.symbol)} / ${addressShort}\n`;
      report += `<i>Пользовательское описание: ${escapeHtml(description)}</i>\n\n`;
      report += `<b>📊 On-chain метрики (${chainStr}):</b>\n`;
      report += `💧 <b>Ликвидность:</b> $${liquidityStr}\n`;
      report += `⏳ <b>Возраст пула:</b> ${ageMin} мин\n`;
      report += `⚠️ <b>Риск-профиль:</b> ${riskLevel} (LOW/MEDIUM/HIGH)\n`;
      report += `🔄 <b>Паттерн:</b> ${pattern}\n\n`;
      if (dexTaReport) {
        report += `${escapeHtml(dexTaReport)}`;
      }
      report += `<b>🐋 Топ-5 недавних транзакций:</b>\n${top5List}\n\n`;
      report += `<b>🧠 Вердикт ИИ: ${aiStatusEmoji} ${aiStatusText}</b>\n`;
      report += `<blockquote expandable>${fullAiVerdictText}</blockquote>`;
    } else {
      report = `<b>🤖 Анализ актива (CEX):</b> ${resolvedTicker.toUpperCase()}\n`;
      report += `<i>Пользовательское описание: ${escapeHtml(description)}</i>\n\n`;
      if (currentPrice) {
        report += `<b>📊 Рыночные данные (Bybit):</b>\n`;
        report += `💵 <b>Цена:</b> ${currentPrice}\n`;
        report += `📈 <b>Изм. 24ч:</b> ${change24h.toFixed(2)}%\n`;
        if (rsi14) report += `📉 <b>RSI(14):</b> ${rsi14.toFixed(1)}\n`;
        if (volumeSpike) report += `🔊 <b>Volume Spike:</b> ${volumeSpike.toFixed(2)}x\n`;
        if (deriv.fundingRate != null) report += `🪙 <b>Фандинг:</b> ${deriv.fundingRate.toFixed(4)}%\n`;
        if (deriv.oiChangePct != null) report += `📊 <b>OI Изм.:</b> ${deriv.oiChangePct.toFixed(2)}%\n`;
        report += `\n`;
      }
      report += `<b>🧠 Вердикт ИИ: ${aiStatusEmoji} ${aiStatusText}</b>\n`;
      report += `<blockquote expandable>${fullAiVerdictText}</blockquote>`;
    }

    await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(report, { parse_mode: 'HTML' });

  } catch (err) {
    console.error('runUserSignalAnalysis', err);
    await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(`❌ Ошибка анализа: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}
