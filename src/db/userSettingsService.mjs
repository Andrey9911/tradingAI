import { supabase } from './supabaseClient.mjs';

/**
 * Загружает настройки пользователя из Supabase.
 * В случае ошибки возвращает null (бот продолжит работу с локальными дефолтными настройками).
 */
export async function loadUserSettings(telegramId) {
  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Запись не найдена — просто возвращаем null
        return null;
      }
      console.error('Ошибка загрузки настроек пользователя из БД:', error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error('Сетевая или непредвиденная ошибка при загрузке настроек:', err);
    return null;
  }
}

/**
 * Синхронно (с await) сохраняет настройки в БД.
 * Обернуто в try/catch, чтобы не прервать работу бота при ошибке.
 */
export async function saveUserSettings(telegramId, data) {
  try {
    const { error } = await supabase
      .from('user_settings')
      .upsert({
        telegram_id: telegramId,
        is_disable_filtr: data.isDisableFiltr,
        sell_spread_pct: data.sell_spread_pct,
        max_entry_chg24_pct: data.max_entry_chg24_pct,
        hold_skip_usd: data.hold_skip_usd,
        filter_liquidity_usd: data.filter_liquidity_usd,
        filter_holders: data.filter_holders,
        filter_volume24h: data.filter_volume24h,
        filter_age_minutes: data.filter_age_minutes,
      }, { onConflict: 'telegram_id' });

    if (error) {
      console.error('Ошибка сохранения настроек пользователя в БД:', error.message);
    }
  } catch (err) {
    console.error('Сетевая или непредвиденная ошибка при сохранении настроек:', err);
  }
}

/**
 * Удобная обертка для сохранения текущих настроек из сессии.
 * Вызывается после каждого изменения настроек.
 */
export async function saveUserSettingsFromSession(ctx) {
  if (!ctx.from?.id) return;
  
  const isDisableFiltr = ctx.session.isDisableFiltr ?? true;
  const signalSettings = ctx.session.signalSettings || {};
  const tokenDiscoveryFilters = ctx.session.tokenDiscoveryFilters || {};

  await saveUserSettings(ctx.from.id, {
    isDisableFiltr: isDisableFiltr,
    sell_spread_pct: signalSettings.sellSpreadPct ?? 5.00,
    max_entry_chg24_pct: signalSettings.maxEntryChg24Pct ?? 15.00,
    hold_skip_usd: signalSettings.holdSkipUsd ?? 10.00,
    filter_liquidity_usd: tokenDiscoveryFilters.liquidityUsd ?? [0, 1000000],
    filter_holders: tokenDiscoveryFilters.holders ?? [0, 100000],
    filter_volume24h: tokenDiscoveryFilters.volume24h ?? [0, 5000000],
    filter_age_minutes: tokenDiscoveryFilters.ageMinutes ?? [0, 1440],
  });
}
