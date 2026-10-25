/**
 * Формирует компактный Telegram-отчёт по детерминированному анализу поведения
 * и безопасно разбивает текст по лимиту сообщения Telegram.
 */

const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Форматирует число с фиксированной точностью или возвращает н/д. */
function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'н/д';
}

/** Разбивает текст по строкам, сохраняя лимит Telegram для каждого сообщения. */
export function splitTelegramMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  const chunks = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= limit) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= limit) {
      current = line;
      continue;
    }
    for (let start = 0; start < line.length; start += limit) {
      chunks.push(line.slice(start, start + limit));
    }
    current = '';
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ['Нет данных для отчёта.'];
}

/** Формирует визуальный текстовый отчёт для Telegram. */
export function formatTradeBehaviorReport(report, aiNarrative) {
  const window = report.analysis_window;
  const patterns = report.patterns.filter(pattern => pattern.evidence_trade_ids.length > 0);
  const lines = [
    '📊 Анализ поведения в сделках',
    `Выборка: ${window.positions} из последних ${window.requested_limit} закрытых позиций`,
    `Средний убыток выборки: ${formatNumber(window.average_loss_usd)} USDT`,
    '',
  ];

  if (!patterns.length) {
    lines.push('Недостаточно данных для проверки доступных поведенческих правил или не найдено сделок, соответствующих их условиям.');
  } else {
    lines.push('Гипотезы:');
    for (const pattern of patterns) {
      const stats = pattern.statistics;
      lines.push(`• ${pattern.name}`);
      lines.push(`  Сделки: ${pattern.evidence_trade_ids.join(', ')}`);
      if (stats.observations != null) {
        const triggered = stats.mean_net_r_triggered ?? stats.mean_pnl_to_average_loss_triggered;
        const comparison = stats.mean_net_r_comparison ?? stats.mean_pnl_to_average_loss_comparison;
        lines.push(`  ${stats.metric_name}: ${formatNumber(triggered)} против ${formatNumber(comparison)}; разница ${formatNumber(stats.difference_in_mean)}`);
      } else {
        lines.push('  Статистика: недостаточно сравнимых наблюдений.');
      }
      lines.push(`  Ограничения: ${pattern.limitations.join(', ')}`);
    }
  }

  const stopDependentFields = new Set(['initial_stop_price', 'trade_plan', 'stop_change_history']);
  const missing = new Set(report.trade_features
    .flatMap(item => item.data_quality.missing_fields)
    .filter(field => !stopDependentFields.has(field)));
  if (missing.size) {
    lines.push('', `Ограничения данных: ${[...missing].join(', ')}.`);
  }
  lines.push('Правила первоначального риска, раннего выхода и ухудшения сценария ожидают сохранённые стопы и торговый план.');
  lines.push('', '🤖 Пояснение ИИ', aiNarrative || 'Недоступно.');
  return splitTelegramMessage(lines.join('\n'));
}
