import { AuthService } from '../services/authService.mjs';
import { BybitService } from '../services/bybitService.mjs';
import { AIService } from '../services/aiService.mjs';
import { InlineKeyboard } from 'grammy';
import { getNewsSentiment } from '../services/searchNews/searchNews.mjs';

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
