/**
 * Проверяет детерминированный расчёт признаков и статистики паттернов
 * на небольшом наборе закрытых фьючерсных позиций.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeTradeBehavior,
  calculateInitialRiskUsd,
  enrichClosedPositionsWithHistory,
  normalizeClosedPosition,
} from '../src/services/tradeBehaviorAnalysisService.mjs';

/** Создаёт тестовую сделку с достаточным набором данных для расчёта. */
function trade(overrides = {}) {
  return {
    trade_id: 'trade-1',
    symbol: 'BTCUSDT',
    side: 'long',
    opened_at: '2026-10-15T12:00:00.000Z',
    closed_at: '2026-10-15T12:10:00.000Z',
    entry_price: 100,
    exit_price: 98,
    position_size_usd: 1000,
    initial_stop_price: 98,
    realized_pnl_usd: -20,
    fees_usd: 1,
    funding_usd: 0,
    ...overrides,
  };
}

test('рассчитывает первоначальный риск для линейной позиции', () => {
  assert.equal(calculateInitialRiskUsd(trade()), 20);
  assert.equal(calculateInitialRiskUsd(trade({ initial_stop_price: null })), null);
});

test('нормализует Bybit closed PnL без подстановки отсутствующих данных', () => {
  const normalized = normalizeClosedPosition({
    orderId: 'order-1', symbol: 'BTCUSDT', side: 'Buy', avgEntryPrice: '100', avgExitPrice: '105',
    cumEntryValue: '1000', closedPnl: '50', updatedTime: '1792066200000',
  });
  assert.equal(normalized.trade_id, 'order-1');
  assert.equal(normalized.side, 'long');
  assert.equal(normalized.initial_stop_price, null);
  assert.equal(normalized.fees_usd, null);
});

test('считает интервалы и совпадение символа для следующей позиции', () => {
  const report = analyzeTradeBehavior([
    trade({ trade_id: 'one', closed_at: '2026-10-15T12:00:00.000Z' }),
    trade({ trade_id: 'two', opened_at: '2026-10-15T12:04:00.000Z', closed_at: '2026-10-15T12:20:00.000Z' }),
  ]);
  const feature = report.trade_features[1];
  assert.equal(feature.time_context.seconds_since_previous_close_market, 240);
  assert.equal(feature.time_context.seconds_since_previous_close_symbol, 240);
  assert.equal(feature.time_context.same_symbol_as_previous, true);
  assert.equal(feature.time_context.same_side_as_previous, true);
});

test('не рассчитывает risk change, net R и ранний выход без стопа и плана', () => {
  const report = analyzeTradeBehavior([
    trade({ trade_id: 'one', initial_stop_price: null, fees_usd: null, funding_usd: null }),
    trade({ trade_id: 'two', initial_stop_price: null, planned_target_price: null, close_reason: 'manual' }),
  ]);
  const second = report.trade_features[1];
  assert.equal(report.normalized_trades[0].net_r, null);
  assert.equal(second.behavior_features.risk_change_pct, null);
  assert.equal(second.behavior_features.early_exit_candidate, null);
  assert.equal(second.data_quality.can_evaluate.risk_increase, false);
  assert.equal(second.data_quality.can_evaluate.early_exit, false);
});

test('рассчитывает net R и статистику быстрого повторного входа', () => {
  const report = analyzeTradeBehavior([
    trade({ trade_id: 'one', closed_at: '2026-10-15T12:00:00.000Z', realized_pnl_usd: -19 }),
    trade({ trade_id: 'two', opened_at: '2026-10-15T12:04:00.000Z', closed_at: '2026-10-15T12:10:00.000Z', realized_pnl_usd: -39 }),
    trade({ trade_id: 'three', opened_at: '2026-10-15T12:30:00.000Z', closed_at: '2026-10-15T12:40:00.000Z', realized_pnl_usd: -19 }),
    trade({ trade_id: 'four', opened_at: '2026-10-15T12:44:00.000Z', closed_at: '2026-10-15T12:50:00.000Z', realized_pnl_usd: -39 }),
    trade({ trade_id: 'five', opened_at: '2026-10-15T14:00:00.000Z', closed_at: '2026-10-15T14:10:00.000Z', realized_pnl_usd: 19 }),
    trade({ trade_id: 'six', opened_at: '2026-10-15T16:00:00.000Z', closed_at: '2026-10-15T16:10:00.000Z', realized_pnl_usd: 19 }),
  ]);
  assert.equal(report.normalized_trades[0].net_pnl_usd, -20);
  assert.equal(report.normalized_trades[0].net_r, -1);
  const pattern = report.patterns.find(item => item.pattern_id === 'BEHAVIOR-001');
  assert.equal(pattern.evidence_trade_ids.length, 2);
  assert.equal(pattern.statistics.metric_name, 'net_r');
  assert.equal(pattern.statistics.observations, 2);
});

test('восстанавливает время входа, комиссии и funding по исполнению и журналу Bybit', () => {
  const closed = [{
    orderId: 'close-1', symbol: 'BTCUSDT', side: 'Buy', avgEntryPrice: '100', avgExitPrice: '98',
    cumEntryValue: '1000', closedPnl: '-20', openFee: '0.4', closeFee: '0.6',
    updatedTime: '1792066200000', closedSize: '10',
  }];
  const executions = [
    { symbol: 'BTCUSDT', orderId: 'open-1', side: 'Buy', execQty: '10', closedSize: '0', orderType: 'Limit', execTime: '1792065600000' },
    { symbol: 'BTCUSDT', orderId: 'close-1', side: 'Sell', execQty: '10', closedSize: '10', orderType: 'Market', execTime: '1792066200000' },
  ];
  const transactions = [{ symbol: 'BTCUSDT', transactionTime: '1792065900000', funding: '-0.2' }];
  const enriched = enrichClosedPositionsWithHistory(closed, executions, transactions);
  const normalized = normalizeClosedPosition(enriched[0]);

  assert.equal(enriched[0].opened_at, '2026-10-15T12:00:00.000Z');
  assert.equal(enriched[0].funding_usd, -0.2);
  assert.equal(normalized.fees_usd, 1);
  assert.deepEqual(normalized.entry_order_types, ['Limit']);
});

test('проверяет удержание убыточной позиции без первоначального стопа', () => {
  const raw = trade({
    trade_id: 'loss-hold',
    initial_stop_price: null,
    opened_at: '2026-10-15T12:00:00.000Z',
    closed_at: '2026-10-15T12:10:00.000Z',
  });
  const report = analyzeTradeBehavior([raw], {
    'loss-hold': [
      { t: Date.parse('2026-10-15T12:00:00.000Z'), o: 100, h: 100, l: 99, c: 99, v: 1 },
      { t: Date.parse('2026-10-15T12:05:00.000Z'), o: 99, h: 100, l: 98, c: 99, v: 1 },
      { t: Date.parse('2026-10-15T12:10:00.000Z'), o: 99, h: 99, l: 98, c: 98, v: 1 },
    ],
  });
  assert.equal(report.trade_features[0].data_quality.can_evaluate.holding_loser, true);
  assert.equal(report.trade_features[0].behavior_features.mae_r, null);
});

test('выявляет быстрый повторный вход без стопа по результату закрытой позиции', () => {
  const report = analyzeTradeBehavior([
    trade({
      trade_id: 'first-loss',
      initial_stop_price: null,
      fees_usd: null,
      funding_usd: null,
      closed_at: '2026-10-15T12:00:00.000Z',
      realized_pnl_usd: -10,
    }),
    trade({
      trade_id: 'reentry',
      initial_stop_price: null,
      opened_at: '2026-10-15T12:04:00.000Z',
      closed_at: '2026-10-15T12:20:00.000Z',
      realized_pnl_usd: -5,
    }),
  ]);
  const rapidReentry = report.patterns.find(pattern => pattern.pattern_id === 'BEHAVIOR-001');
  assert.deepEqual(rapidReentry.evidence_trade_ids, ['reentry']);
  assert.equal(report.trade_features[1].data_quality.can_evaluate.rapid_reentry, true);
});
