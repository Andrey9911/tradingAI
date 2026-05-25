function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtNum(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toFixed(digits);
}

function verdictEmoji(v) {
  if (v === 'BUY') return '🟢';
  if (v === 'AVOID') return '🔴';
  return '🟡';
}

function entryLine(parsed) {
  const e = parsed.entry;
  if (e.type === 'RANGE' && e.min != null && e.max != null) {
    return `${fmtNum(e.min, 4)}–${fmtNum(e.max, 4)}`;
  }
  if (e.type === 'LEVELS' && e.levels?.length) {
    return e.levels.map(x => fmtNum(x, 4)).join(' / ');
  }
  if (e.min != null) return fmtNum(e.min, 4);
  return '—';
}

/**
 * @param {object} analysis — результат SignalAnalysisService.analyze
 */
export function formatAiSignalHtml(analysis) {
  const { parsed, symbolNormalized, verdict, score, risk, aiAdvice, aiReason, snapshot, sourceTitle } =
    analysis;
  const side = parsed.side;
  const vEmoji = verdictEmoji(verdict);
  const src = sourceTitle ? esc(sourceTitle) : 'не указан';

  const tps = (parsed.takeProfits || []).map(t => fmtNum(t, 4)).join(' / ') || '—';
  const sl = parsed.stopLoss != null ? fmtNum(parsed.stopLoss, 4) : '—';

  let statusRu = 'в зоне входа';
  if (analysis.entryStatus === 'ABOVE_ENTRY') {
    statusRu =
      analysis.entryLatePct != null
        ? `выше entry на +${fmtNum(analysis.entryLatePct, 2)}%`
        : 'выше зоны входа';
  }
  if (analysis.entryStatus === 'BELOW_ENTRY') {
    statusRu =
      analysis.entryLatePct != null
        ? `ниже entry на ${fmtNum(analysis.entryLatePct, 2)}%`
        : 'ниже зоны входа';
  }

  const ch = snapshot.change24h;
  const chStr = ch != null && Number.isFinite(ch) ? `${ch >= 0 ? '+' : ''}${fmtNum(ch, 2)}%` : '—';

  const warnBlock =
    analysis.userWarnings?.length > 0
      ? `\n\n⚠️ <b>Внимание</b>\n${analysis.userWarnings.map(w => `• ${esc(w)}`).join('\n')}`
      : '';

  return (
    `🤖 <b>${esc(symbolNormalized)}</b> ${esc(side)} — ${vEmoji} <b>${esc(verdict)}</b>\n\n` +
    `<b>Совет:</b> ${esc(aiAdvice)}\n\n` +
    `<b>Оценка:</b> ${score}/100\n` +
    `<b>Риск:</b> ${esc(risk)}\n` +
    `<b>Источник:</b> ${src}\n\n` +
    `💰 <b>Сделка</b>\n` +
    `Entry: ${entryLine(parsed)}\n` +
    `Сейчас: ${fmtNum(snapshot.currentPrice, 4)}\n` +
    `Статус: ${esc(statusRu)}\n` +
    `SL: ${sl}\n` +
    `TP: ${tps}\n\n` +
    `📊 <b>RR</b>\n` +
    `TP1: ${fmtNum(analysis.rr?.tp1, 2)}\n` +
    `TP2: ${fmtNum(analysis.rr?.tp2, 2)}\n` +
    `TP3: ${fmtNum(analysis.rr?.tp3, 2)}\n\n` +
    `📈 <b>Метрики</b>\n` +
    `24ч: ${chStr}\n` +
    `RSI 1h: ${fmtNum(snapshot.rsi1h, 1)}\n` +
    `OI 1h: ${snapshot.oiChange1h != null ? `${snapshot.oiChange1h >= 0 ? '+' : ''}${fmtNum(snapshot.oiChange1h, 2)}%` : '—'}\n` +
    `Funding: ${snapshot.fundingRate != null ? `${snapshot.fundingRate >= 0 ? '+' : ''}${fmtNum(snapshot.fundingRate, 4)}%` : '—'}\n` +
    `Volume spike: ${snapshot.volumeSpike != null ? `${fmtNum(snapshot.volumeSpike, 2)}x` : '—'}\n` +
    `Spread: ${snapshot.spreadPct != null ? `${fmtNum(snapshot.spreadPct, 4)}%` : '—'}\n\n` +
    `🧠 <b>Почему</b>\n` +
    `${esc(aiReason)}` +
    warnBlock
  );
}
