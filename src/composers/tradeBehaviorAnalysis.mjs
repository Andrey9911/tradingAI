/**
 * Обрабатывает запуск анализа поведения из Telegram и связывает Bybit,
 * детерминированный расчёт, AI-пояснение и форматированный отчёт.
 */

import { Composer } from 'grammy';
import { AuthService } from '../services/authService.mjs';
import { AIService } from '../services/aiService.mjs';
import { BybitService } from '../services/bybitService.mjs';
import { analyzeTradeBehavior, enrichClosedPositionsWithHistory, normalizeClosedPosition } from '../services/tradeBehaviorAnalysisService.mjs';
import { formatTradeBehaviorReport } from '../formatters/tradeBehaviorFormatter.mjs';

export const tradeBehaviorAnalysisComposer = new Composer();

/** Загружает свечи для сделок, где они нужны для расчёта удержания убытка. */
async function loadMarketHistory(bybit, rawTrades) {
  const history = {};
  const eligible = rawTrades
    .map(normalizeClosedPosition)
    .filter(trade => trade.trade_id && trade.symbol && trade.opened_at && trade.closed_at);

  const queue = [...eligible];
  const worker = async () => {
    while (queue.length) {
      const trade = queue.shift();
      const start = Date.parse(trade.opened_at);
      const end = Date.parse(trade.closed_at);
      try {
        history[trade.trade_id] = await bybit.getKlines(trade.symbol, '5', 1000, {
          category: 'linear',
          start,
          end,
        });
      } catch {
        history[trade.trade_id] = [];
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return history;
}

/** Запускает полный анализ и отправляет отчёт владельцу бота. */
export async function runTradeBehaviorAnalysis(ctx) {
  const progress = await ctx.reply('⏳ Анализирую сделки...');
  try {
    const keys = await new AuthService().getUserKeys(ctx.from.id);
    if (!keys) {
      await ctx.reply('❌ Не найдены ключи Bybit. Используйте /register.');
      return;
    }
    const bybit = new BybitService(keys.apiKey, keys.apiSecret);
    const closedPositions = await bybit.getRecentClosedLinearPositions(50);
    if (!closedPositions.length) {
      await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => {});
      await ctx.reply('Закрытые linear-позиции для анализа не найдены.');
      return;
    }
    const earliestClosedAt = Math.min(...closedPositions.map(item => Number(item.updatedTime || item.createdTime || Date.now())));
    const historyStart = earliestClosedAt - 90 * 24 * 60 * 60 * 1000;
    const [executions, transactions] = await Promise.all([
      bybit.getLinearExecutionHistory(historyStart, Date.now()),
      bybit.getLinearTransactionHistory(historyStart, Date.now()),
    ]);
    const rawTrades = enrichClosedPositionsWithHistory(closedPositions, executions, transactions);
    const marketHistory = await loadMarketHistory(bybit, rawTrades);
    const report = analyzeTradeBehavior(rawTrades, marketHistory);
    const aiNarrative = await new AIService().explainTradeBehaviorPatterns(report);
    const messages = formatTradeBehaviorReport(report, aiNarrative);
    await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => {});
    for (const message of messages) await ctx.reply(message);
  } catch (err) {
    console.error('runTradeBehaviorAnalysis:', err);
    await ctx.reply(`❌ Не удалось выполнить анализ сделок: ${err.message}`);
  }
}

tradeBehaviorAnalysisComposer.callbackQuery('menu_trade_behavior', async ctx => {
  await ctx.answerCallbackQuery().catch(() => {});
  await runTradeBehaviorAnalysis(ctx);
});
