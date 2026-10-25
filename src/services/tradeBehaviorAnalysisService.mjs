/**
 * Нормализует закрытые фьючерсные позиции, рассчитывает признаки поведения
 * и формирует ограниченный набор детерминированных торговых гипотез.
 */

const RAPID_REENTRY_SECONDS = 300;
const HOLDING_LOSER_SECONDS = 1800;
const MIN_PATTERN_OBSERVATIONS = 2;

/** Приводит число к конечному числу или null. */
function toNumber(value) {
  if (value == null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

/** Приводит Unix timestamp в миллисекундах или ISO-строку к ISO-строке. */
function toIso(value) {
  if (value == null || value === '') return null;
  const numeric = toNumber(value);
  const date = numeric != null ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Возвращает разницу времени в секундах, когда обе даты известны. */
function secondsBetween(later, earlier) {
  const laterTime = Date.parse(later || '');
  const earlierTime = Date.parse(earlier || '');
  if (!Number.isFinite(laterTime) || !Number.isFinite(earlierTime)) return null;
  return Math.max(0, Math.round((laterTime - earlierTime) / 1000));
}

/** Возвращает чистый PnL только когда известны все его составляющие. */
function calculateNetPnl(trade) {
  if (trade.realized_pnl_usd == null || trade.fees_usd == null || trade.funding_usd == null) return null;
  return trade.realized_pnl_usd - trade.fees_usd - trade.funding_usd;
}

/** Определяет направление позиции из форматов Bybit и внутреннего DTO. */
function normalizeSide(value) {
  const side = String(value || '').toLowerCase();
  if (side === 'buy' || side === 'long') return 'long';
  if (side === 'sell' || side === 'short') return 'short';
  return null;
}

/** Рассчитывает первоначальный риск для linear USDT-позиции. */
export function calculateInitialRiskUsd(trade) {
  if (
    trade.entry_price == null ||
    trade.initial_stop_price == null ||
    trade.position_size_usd == null ||
    trade.entry_price <= 0
  ) return null;
  const risk = Math.abs(trade.entry_price - trade.initial_stop_price) / trade.entry_price * trade.position_size_usd;
  return Number.isFinite(risk) && risk > 0 ? risk : null;
}

/**
 * Нормализует ответ Bybit или уже частично подготовленную позицию в закрытый DTO.
 * Неизвестные значения сохраняются как null, чтобы не подменять их догадками.
 */
export function normalizeClosedPosition(raw) {
  const entryPrice = toNumber(raw.entry_price ?? raw.avgEntryPrice);
  const exitPrice = toNumber(raw.exit_price ?? raw.avgExitPrice);
  const closedSize = toNumber(raw.position_size_usd ?? raw.cumEntryValue ?? raw.cumExitValue);
  const leverage = toNumber(raw.leverage);
  const initialStop = toNumber(raw.initial_stop_price ?? raw.initialStopPrice);
  const realizedPnl = toNumber(raw.realized_pnl_usd ?? raw.closedPnl ?? raw.realisedPnl);
  const directFees = toNumber(raw.fees_usd ?? raw.feesUsd);
  const openFee = toNumber(raw.openFee);
  const closeFee = toNumber(raw.closeFee);
  const fees = directFees ?? (openFee != null && closeFee != null ? openFee + closeFee : null);
  const funding = toNumber(raw.funding_usd ?? raw.fundingUsd);

  return {
    trade_id: String(raw.trade_id ?? raw.orderId ?? raw.execId ?? raw.id ?? '').trim() || null,
    symbol: String(raw.symbol || '').trim().toUpperCase() || null,
    market_type: raw.market_type ?? 'linear_perpetual',
    side: normalizeSide(raw.side ?? raw.positionSide),
    opened_at: toIso(raw.opened_at ?? raw.openedAt),
    closed_at: toIso(raw.closed_at ?? raw.closedAt ?? raw.updatedTime ?? raw.createdTime),
    entry_price: entryPrice,
    exit_price: exitPrice,
    position_size_usd: closedSize,
    leverage,
    entry_order_types: Array.isArray(raw.entry_order_types) ? raw.entry_order_types : [],
    exit_order_types: Array.isArray(raw.exit_order_types) ? raw.exit_order_types : [],
    close_reason: raw.close_reason ? String(raw.close_reason).toLowerCase() : raw.closeType ? String(raw.closeType).toLowerCase() : null,
    was_liquidated: typeof raw.was_liquidated === 'boolean' ? raw.was_liquidated : raw.closeType === 'Liquidation',
    realized_pnl_usd: realizedPnl,
    fees_usd: fees,
    funding_usd: funding,
    initial_stop_price: initialStop,
    stop_moved_away: typeof raw.stop_moved_away === 'boolean' ? raw.stop_moved_away : null,
    mae_usd: toNumber(raw.mae_usd),
    time_in_loss_seconds: toNumber(raw.time_in_loss_seconds),
    recovered_to_entry: typeof raw.recovered_to_entry === 'boolean' ? raw.recovered_to_entry : null,
    time_after_invalidation_seconds: toNumber(raw.time_after_invalidation_seconds),
    planned_target_price: toNumber(raw.planned_target_price),
    invalidation_price: toNumber(raw.invalidation_price),
    initial_risk_usd: null,
    net_pnl_usd: null,
    net_r: null,
    pnl_precision: fees != null && funding != null ? 'complete' : 'closed_pnl_only',
  };
}

/** Возвращает направление, которое уменьшается исполнением противоположной стороны. */
function closedPositionSide(executionSide) {
  const side = normalizeSide(executionSide);
  if (!side) return null;
  return side === 'long' ? 'short' : 'long';
}

/** Возвращает числовой объём исполнения, доступный для учёта позиции. */
function executionQuantity(execution, field) {
  return Math.max(0, toNumber(execution[field]) ?? 0);
}

/**
 * Восстанавливает начало циклов позиций по закрывающему объёму исполнений.
 * При отсутствии closedSize или несовпадении направления запись не обогащается.
 */
export function enrichClosedPositionsWithHistory(closedPositions, executions, transactions) {
  const activePositions = new Map();
  const closuresByOrderId = new Map();
  const sortedExecutions = [...executions].sort((left, right) => Number(left.execTime || 0) - Number(right.execTime || 0));

  for (const execution of sortedExecutions) {
    const symbol = String(execution.symbol || '').toUpperCase();
    const side = normalizeSide(execution.side);
    const quantity = executionQuantity(execution, 'execQty');
    const closedSize = Math.min(quantity, executionQuantity(execution, 'closedSize'));
    if (!symbol || !side || quantity <= 0) continue;

    if (closedSize > 0) {
      const closingSide = closedPositionSide(execution.side);
      const closingKey = `${symbol}:${closingSide}`;
      const active = activePositions.get(closingKey);
      if (active && active.quantity + 1e-12 >= closedSize) {
        const existing = closuresByOrderId.get(execution.orderId);
        closuresByOrderId.set(execution.orderId, {
          opened_at: existing?.opened_at ?? active.opened_at,
          entry_order_types: [...new Set([...(existing?.entry_order_types ?? []), ...active.entry_order_types])],
          exit_order_types: [...new Set([...(existing?.exit_order_types ?? []), execution.orderType].filter(Boolean))],
        });
        active.quantity -= closedSize;
        if (active.quantity <= 1e-12) activePositions.delete(closingKey);
      }
    }

    const openingSize = quantity - closedSize;
    if (openingSize > 1e-12) {
      const openingKey = `${symbol}:${side}`;
      const active = activePositions.get(openingKey);
      if (active) {
        active.quantity += openingSize;
        if (execution.orderType) active.entry_order_types.add(execution.orderType);
      } else {
        activePositions.set(openingKey, {
          quantity: openingSize,
          opened_at: toIso(execution.execTime),
          entry_order_types: new Set(execution.orderType ? [execution.orderType] : []),
        });
      }
    }
  }

  return closedPositions.map(position => {
    const closure = closuresByOrderId.get(position.orderId);
    if (!closure?.opened_at) return position;
    const openedAt = Date.parse(closure.opened_at);
    const closedAt = Number(position.updatedTime ?? position.createdTime);
    const symbol = String(position.symbol || '').toUpperCase();
    const fundingRows = transactions.filter(transaction => (
      String(transaction.symbol || '').toUpperCase() === symbol &&
      Number(transaction.transactionTime || 0) >= openedAt &&
      Number(transaction.transactionTime || 0) <= closedAt &&
      toNumber(transaction.funding) != null
    ));
    const funding = fundingRows.reduce((sum, transaction) => sum + (toNumber(transaction.funding) ?? 0), 0);

    return {
      ...position,
      opened_at: closure.opened_at,
      entry_order_types: closure.entry_order_types,
      exit_order_types: closure.exit_order_types,
      funding_usd: funding,
      funding_data_available: true,
      reconstruction_status: 'execution_matched',
    };
  });
}

/** Рассчитывает MAE, время в убытке и возврат к цене входа по свечам сделки. */
export function calculateMarketHistoryFeatures(trade, candles) {
  if (!Array.isArray(candles) || !candles.length || trade.entry_price == null || trade.opened_at == null || trade.closed_at == null) {
    return { mae_usd: null, time_in_loss_seconds: null, recovered_to_entry: null };
  }
  const openedAt = Date.parse(trade.opened_at);
  const closedAt = Date.parse(trade.closed_at);
  const inTrade = candles.filter(candle => candle.t >= openedAt && candle.t <= closedAt);
  const firstCandle = candles[0];
  const lastCandle = candles.at(-1);
  if (
    !inTrade.length ||
    firstCandle.t > openedAt ||
    lastCandle.t < closedAt - 5 * 60 * 1000 ||
    trade.position_size_usd == null ||
    trade.entry_price <= 0 ||
    !trade.side
  ) {
    return { mae_usd: null, time_in_loss_seconds: null, recovered_to_entry: null };
  }
  const isLong = trade.side === 'long';
  let worstLoss = 0;
  let lossSeconds = 0;
  let recovered = false;
  let previousTime = openedAt;
  let wasInLoss = false;

  for (const candle of inTrade) {
    const adversePrice = isLong ? candle.l : candle.h;
    const closePrice = candle.c;
    const adversePnl = (isLong ? adversePrice - trade.entry_price : trade.entry_price - adversePrice) / trade.entry_price * trade.position_size_usd;
    worstLoss = Math.min(worstLoss, adversePnl);
    const closePnl = (isLong ? closePrice - trade.entry_price : trade.entry_price - closePrice) / trade.entry_price * trade.position_size_usd;
    if (closePnl < 0) lossSeconds += Math.max(0, Math.min(candle.t, closedAt) - previousTime) / 1000;
    const recoveryPrice = isLong ? candle.h : candle.l;
    if (wasInLoss && (isLong ? recoveryPrice >= trade.entry_price : recoveryPrice <= trade.entry_price)) recovered = true;
    if (closePnl < 0) wasInLoss = true;
    previousTime = candle.t;
  }
  return {
    mae_usd: Math.abs(worstLoss),
    time_in_loss_seconds: Math.round(lossSeconds),
    recovered_to_entry: wasInLoss ? recovered : false,
  };
}

/** Вычисляет признаки одной позиции с учётом предыдущих закрытий. */
function calculateTradeFeatures(trade, previousTrades, averageLoss) {
  const previous = previousTrades.at(-1) || null;
  const previousSameSymbol = [...previousTrades].reverse().find(item => item.symbol && item.symbol === trade.symbol) || null;
  const previousSameSide = [...previousTrades].reverse().find(item => item.symbol === trade.symbol && item.side === trade.side) || null;
  const previousLoss = [...previousTrades].reverse().find(item => (item.net_pnl_usd ?? item.realized_pnl_usd) != null && (item.net_pnl_usd ?? item.realized_pnl_usd) < 0) || null;
  const initialRisk = trade.initial_risk_usd;
  const previousRisk = previous?.initial_risk_usd ?? null;
  const netPnl = trade.net_pnl_usd;
  const hasPlan = trade.planned_target_price != null || trade.invalidation_price != null;
  const canHistory = trade.mae_usd != null && trade.time_in_loss_seconds != null && trade.recovered_to_entry != null;
  const canRapid = Boolean(trade.opened_at && previous?.closed_at);
  const canSameSymbol = Boolean(trade.opened_at && previousSameSymbol?.closed_at && trade.symbol);
  const canRisk = initialRisk != null && previousRisk != null && previousRisk > 0;
  const delay = previous ? secondsBetween(trade.opened_at, previous.closed_at) : null;

  return {
    trade_id: trade.trade_id,
    time_context: {
      previous_trade_id: previous?.trade_id ?? null,
      seconds_since_previous_close_market: delay,
      seconds_since_previous_close_symbol: previousSameSymbol ? secondsBetween(trade.opened_at, previousSameSymbol.closed_at) : null,
      seconds_since_previous_close_same_side: previousSameSide ? secondsBetween(trade.opened_at, previousSameSide.closed_at) : null,
      seconds_since_previous_loss: previousLoss ? secondsBetween(trade.opened_at, previousLoss.closed_at) : null,
      previous_trade_net_pnl_usd: previous?.net_pnl_usd ?? null,
      previous_trade_was_loss: (previous?.net_pnl_usd ?? previous?.realized_pnl_usd) != null
        ? (previous.net_pnl_usd ?? previous.realized_pnl_usd) < 0
        : null,
      previous_trade_symbol: previous?.symbol ?? null,
      same_symbol_as_previous: previous?.symbol && trade.symbol ? previous.symbol === trade.symbol : null,
      same_side_as_previous: previous?.side && trade.side ? previous.side === trade.side : null,
    },
    behavior_features: {
      initial_risk_usd: initialRisk,
      previous_initial_risk_usd: previousRisk,
      risk_change_pct: canRisk ? (initialRisk - previousRisk) / previousRisk * 100 : null,
      position_notional_change_pct: previous?.position_size_usd != null && previous.position_size_usd > 0 && trade.position_size_usd != null
        ? (trade.position_size_usd - previous.position_size_usd) / previous.position_size_usd * 100
        : null,
      early_exit_candidate: hasPlan && trade.close_reason === 'manual' && trade.planned_target_price != null
        ? (trade.side === 'long' ? trade.exit_price < trade.planned_target_price : trade.exit_price > trade.planned_target_price)
        : null,
      early_exit_evidence: hasPlan && trade.close_reason === 'manual' ? 'manual_close_before_planned_target' : null,
      time_in_loss_seconds: trade.time_in_loss_seconds,
      mae_r: trade.mae_usd != null && initialRisk != null && initialRisk > 0 ? trade.mae_usd / initialRisk : null,
      recovered_to_entry: trade.recovered_to_entry,
      time_after_invalidation_seconds: trade.time_after_invalidation_seconds,
      stop_moved_away: trade.stop_moved_away,
      pnl_to_average_loss: (netPnl ?? trade.realized_pnl_usd) != null && averageLoss != null && averageLoss > 0
        ? (netPnl ?? trade.realized_pnl_usd) / averageLoss
        : null,
    },
    data_quality: {
      missing_fields: [
        !trade.opened_at && 'opened_at',
        !trade.initial_stop_price && 'initial_stop_price',
        trade.fees_usd == null && 'fees_usd',
        trade.funding_usd == null && 'funding_usd',
        !hasPlan && 'trade_plan',
        !canHistory && 'market_history',
        trade.stop_moved_away == null && 'stop_change_history',
      ].filter(Boolean),
      pnl_precision: trade.pnl_precision,
      can_evaluate: {
        rapid_reentry: canRapid,
        risk_increase: canRisk,
        early_exit: hasPlan && trade.exit_price != null && trade.close_reason != null,
        same_symbol_reentry: canSameSymbol,
        holding_loser: canHistory,
        scenario_deterioration: trade.invalidation_price != null && trade.time_after_invalidation_seconds != null && trade.stop_moved_away != null,
      },
    },
  };
}

/** Возвращает исходную метрику текущей сделки для статистики паттернов. */
function getOutcome(item) {
  if (item.trade.net_r != null) return { name: 'net_r', value: item.trade.net_r };
  const fallback = item.features.behavior_features.pnl_to_average_loss;
  return fallback != null ? { name: 'pnl_to_average_loss', value: fallback } : null;
}

/** Строит статистику гипотезы по триггерной и контрольной группам. */
function buildPattern({ id, name, category, trigger, condition, trades, predicate, controls = [] }) {
  const candidates = trades.filter(item => predicate(item));
  const triggered = candidates.map(getOutcome).filter(Boolean);
  const metricName = triggered.length ? triggered[0].name : null;
  const comparable = metricName ? trades.filter(item => !predicate(item)).map(getOutcome).filter(item => item?.name === metricName) : [];
  const mean = list => list.length ? list.reduce((sum, item) => sum + item.value, 0) / list.length : null;
  const meanTriggered = mean(triggered);
  const meanComparison = mean(comparable);
  const enough = triggered.length >= MIN_PATTERN_OBSERVATIONS && comparable.length >= MIN_PATTERN_OBSERVATIONS;

  return {
    pattern_id: id,
    name,
    category,
    status: 'hypothesis',
    definition: { trigger, condition },
    statistics: {
      observations: enough ? triggered.length : null,
      comparison_observations: enough ? comparable.length : null,
      metric_name: enough ? metricName : null,
      mean_net_r_triggered: enough && metricName === 'net_r' ? meanTriggered : null,
      mean_net_r_comparison: enough && metricName === 'net_r' ? meanComparison : null,
      mean_pnl_to_average_loss_triggered: enough && metricName === 'pnl_to_average_loss' ? meanTriggered : null,
      mean_pnl_to_average_loss_comparison: enough && metricName === 'pnl_to_average_loss' ? meanComparison : null,
      difference_in_mean: enough ? meanTriggered - meanComparison : null,
    },
    controls,
    control_data_status: Object.fromEntries(controls.map(control => [control, 'unavailable'])),
    limitations: ['observational_data', 'causality_not_established', ...(enough ? [] : ['insufficient_comparison_sample'])],
    evidence_trade_ids: candidates.map(item => item.trade.trade_id).filter(Boolean).slice(0, 5),
    recommendation: 'Проверьте сделки из списка и наличие заранее определённого торгового плана.',
  };
}

/** Нормализует позиции и рассчитывает полный детерминированный отчёт по поведению. */
export function analyzeTradeBehavior(rawTrades, marketHistoryByTradeId = {}) {
  const normalized = rawTrades
    .map(normalizeClosedPosition)
    .filter(trade => trade.closed_at)
    .sort((left, right) => Date.parse(left.closed_at) - Date.parse(right.closed_at));
  const losses = normalized.map(item => item.realized_pnl_usd).filter(value => value != null && value < 0).map(Math.abs);
  const averageLoss = losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : null;

  for (const trade of normalized) {
    trade.initial_risk_usd = calculateInitialRiskUsd(trade);
    trade.net_pnl_usd = calculateNetPnl(trade);
    trade.net_r = trade.net_pnl_usd != null && trade.initial_risk_usd != null && trade.initial_risk_usd > 0
      ? trade.net_pnl_usd / trade.initial_risk_usd
      : null;
    const marketFeatures = calculateMarketHistoryFeatures(trade, marketHistoryByTradeId[trade.trade_id]);
    trade.mae_usd = trade.mae_usd ?? marketFeatures.mae_usd;
    trade.time_in_loss_seconds = trade.time_in_loss_seconds ?? marketFeatures.time_in_loss_seconds;
    trade.recovered_to_entry = trade.recovered_to_entry ?? marketFeatures.recovered_to_entry;
  }

  const featureTrades = normalized.map((trade, index) => ({
    trade,
    features: calculateTradeFeatures(trade, normalized.slice(0, index), averageLoss),
  }));
  const previousLoss = item => item.features.time_context.previous_trade_was_loss === true;
  const patterns = [
    buildPattern({ id: 'BEHAVIOR-001', name: 'Быстрый повторный вход после убытка', category: 'revenge_trading_candidate', trigger: 'previous_trade_net_pnl_usd < 0', condition: `seconds_since_previous_close_market <= ${RAPID_REENTRY_SECONDS}`, trades: featureTrades, predicate: item => previousLoss(item) && item.features.data_quality.can_evaluate.rapid_reentry && item.features.time_context.seconds_since_previous_close_market <= RAPID_REENTRY_SECONDS, controls: ['strategy', 'market_volatility', 'trading_session'] }),
    buildPattern({ id: 'BEHAVIOR-002', name: 'Повторный вход в тот же символ после убытка', category: 'same_symbol_reentry_candidate', trigger: 'previous_trade_net_pnl_usd < 0', condition: 'same_symbol_as_previous = true', trades: featureTrades, predicate: item => previousLoss(item) && item.features.data_quality.can_evaluate.same_symbol_reentry && item.features.time_context.same_symbol_as_previous === true, controls: ['strategy', 'market_volatility'] }),
    buildPattern({ id: 'BEHAVIOR-003', name: 'Увеличение первоначального риска после убытка', category: 'risk_increase_candidate', trigger: 'previous_trade_net_pnl_usd < 0', condition: 'risk_change_pct > 0', trades: featureTrades, predicate: item => previousLoss(item) && item.features.data_quality.can_evaluate.risk_increase && item.features.behavior_features.risk_change_pct > 0, controls: ['strategy', 'market_volatility'] }),
    buildPattern({ id: 'BEHAVIOR-004', name: 'Увеличение номинала после убытка', category: 'position_size_increase_candidate', trigger: 'previous_trade_net_pnl_usd < 0', condition: 'position_notional_change_pct > 0', trades: featureTrades, predicate: item => previousLoss(item) && item.features.behavior_features.position_notional_change_pct > 0, controls: ['strategy', 'market_volatility'] }),
    buildPattern({ id: 'BEHAVIOR-005', name: 'Длительное удержание убыточной позиции', category: 'holding_loser_candidate', trigger: 'time_in_loss_seconds available', condition: `time_in_loss_seconds >= ${HOLDING_LOSER_SECONDS}`, trades: featureTrades, predicate: item => item.features.data_quality.can_evaluate.holding_loser && item.features.behavior_features.time_in_loss_seconds >= HOLDING_LOSER_SECONDS, controls: ['strategy', 'market_volatility'] }),
    buildPattern({ id: 'BEHAVIOR-006', name: 'Ухудшение сценария после отмены', category: 'scenario_deterioration_candidate', trigger: 'invalidation level crossed', condition: 'stop_moved_away = true', trades: featureTrades, predicate: item => item.features.data_quality.can_evaluate.scenario_deterioration && item.features.behavior_features.stop_moved_away === true, controls: ['strategy', 'market_volatility'] }),
  ];

  console.log('Normalized Trades:', normalized);
  
  return {
    analysis_window: { positions: normalized.length, requested_limit: 50, average_loss_usd: averageLoss },
    normalized_trades: normalized,
    trade_features: featureTrades.map(item => item.features),
    patterns,
  };
}
