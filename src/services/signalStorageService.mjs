import { supabase } from '../db/supabaseClient.mjs';

function numOrNull(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  return Number(v);
}

export class SignalStorageService {
  /**
   * @param {number} telegramUserId
   * @param {object} postRow
   * @returns {Promise<string|null>} id raw post
   */
  async saveTelegramSignalPost(telegramUserId, postRow) {
    const { data, error } = await supabase
      .from('telegram_signal_posts')
      .insert({
        telegram_user_id: telegramUserId,
        source_type: postRow.sourceType,
        source_title: postRow.sourceTitle,
        source_chat_id: postRow.sourceChatId,
        source_message_id: postRow.sourceMessageId,
        source_posted_at: postRow.sourcePostedAt,
        raw_text: postRow.rawText,
      })
      .select('id')
      .single();

    if (error) {
      console.error('saveTelegramSignalPost:', error);
      return null;
    }
    return data?.id ?? null;
  }

  /**
   * @returns {Promise<string|null>} trade_signals.id
   */
  async saveTradeSignal(telegramUserId, rawPostId, parsed, analysis) {
    const e = parsed.entry;
    const row = {
      telegram_user_id: telegramUserId,
      raw_post_id: rawPostId,
      source_title: analysis.sourceTitle,
      symbol: analysis.symbolNormalized,
      side: parsed.side,
      market_type: parsed.marketType,
      entry_type: e.type,
      entry_min: numOrNull(e.min),
      entry_max: numOrNull(e.max),
      entry_levels: e.levels ?? [],
      take_profits: parsed.takeProfits ?? [],
      stop_loss: numOrNull(parsed.stopLoss),
      leverage: numOrNull(parsed.leverage),
      timeframe: parsed.timeframe ?? null,
      current_price: analysis.currentPrice,
      entry_status: analysis.entryStatus,
      entry_late_pct: numOrNull(analysis.entryLatePct),
      score: analysis.score,
      verdict: analysis.verdict,
      risk: analysis.risk,
      ai_reason: analysis.aiReason,
      status: 'analyzed',
    };

    const { data, error } = await supabase.from('trade_signals').insert(row).select('id').single();
    if (error) {
      console.error('saveTradeSignal:', error);
      return null;
    }
    return data?.id ?? null;
  }

  /**
   * @param {string} signalId
   * @param {object} snapshot
   */
  async saveMarketSnapshot(signalId, snapshot) {
    const row = {
      signal_id: signalId,
      current_price: snapshot.currentPrice,
      change_24h: snapshot.change24h,
      volume_24h: snapshot.volume24h,
      turnover_24h: snapshot.turnover24h,
      rsi_1h: numOrNull(snapshot.rsi1h),
      ema_20_1h: numOrNull(snapshot.ema20_1h),
      ema_50_1h: numOrNull(snapshot.ema50_1h),
      atr_14_1h: numOrNull(snapshot.atr14_1h),
      volume_spike: numOrNull(snapshot.volumeSpike),
      spread_pct: numOrNull(snapshot.spreadPct),
      oi_change_1h: numOrNull(snapshot.oiChange1h),
      oi_change_4h: numOrNull(snapshot.oiChange4h),
      oi_change_24h: numOrNull(snapshot.oiChange24h),
      funding_rate: numOrNull(snapshot.fundingRate),
      long_short_ratio: numOrNull(snapshot.longShortRatio),
      raw_json: snapshot.rawJson ?? {},
    };

    const { error } = await supabase.from('signal_market_snapshots').insert(row);
    if (error) console.error('saveMarketSnapshot:', error);
  }
}
