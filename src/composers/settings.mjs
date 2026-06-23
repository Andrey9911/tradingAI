import { Composer, InlineKeyboard } from 'grammy';
import { getTokenDiscoveryFilters } from '../services/tokenDiscoveryService.mjs';

export const settingsComposer = new Composer();

const DEFAULT_SIGNAL_SETTINGS = {
  sellSpreadPct: parseFloat(process.env.SIGNAL_SELL_SPREAD_PCT || '5'),
  maxEntryChg24Pct: parseFloat(process.env.SIGNAL_MAX_ENTRY_CHG24_PCT || '15'),
  holdSkipUsd: parseFloat(process.env.SIGNAL_HOLD_SKIP_USD || '10'),
};

function getSignalSettings(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.signalSettings) ctx.session.signalSettings = { ...DEFAULT_SIGNAL_SETTINGS };

  ctx.session.isDisableFiltr ??= true;
  // Подмешиваем значения из env, если ключей не хватает.
  ctx.session.signalSettings.sellSpreadPct ??= DEFAULT_SIGNAL_SETTINGS.sellSpreadPct;
  ctx.session.signalSettings.maxEntryChg24Pct ??= DEFAULT_SIGNAL_SETTINGS.maxEntryChg24Pct;
  ctx.session.signalSettings.holdSkipUsd ??= DEFAULT_SIGNAL_SETTINGS.holdSkipUsd;

  return ctx.session.signalSettings;
}

const TOKEN_FILTER_LABELS = {
  liquidityUsd: 'Ликвидность',
  holders: 'Холдеры',
  volume24h: 'Объём 24ч',
  ageMinutes: 'Возраст',
};

function parseNumber(input) {
  // Позволяем ввод вида: "15", "15.5", "+15%", "15,2"
  const normalized = String(input).replace(',', '.').trim();
  const cleaned = normalized.replace(/[^0-9.+-]/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

export async function showSettingsMenu(ctx) {
  const s = getSignalSettings(ctx);
  const t = getTokenDiscoveryFilters(ctx); // для краткости назовем t

  const keyboard = new InlineKeyboard()
    .text(`📈 Спред продажи > ${s.sellSpreadPct}%`, 'settings_edit_sellSpreadPct')
    .text(`📉 Вход: 24ч рост < +${s.maxEntryChg24Pct}%`, 'settings_edit_maxEntryChg24Pct')
    .row()
    .text(`💧 Liq: $${t.liquidityUsd[0]}-$${t.liquidityUsd[1]}`, 'settings_edit_token_liquidityUsd')
    .text(`👥 Hold: ${t.holders[0]}-${t.holders[1]}`, 'settings_edit_token_holders')
    .row()
    .text(`📊 Vol: $${t.volume24h[0]}-$${t.volume24h[1]}`, 'settings_edit_token_volume24h')
    .text(`⏱ Age: ${t.ageMinutes[0]}-${t.ageMinutes[1]}m`, 'settings_edit_token_ageMinutes')
    .row()
    .text(`Фильтры ${ctx.session.isDisableFiltr ? 'отключены' : 'включены'}`, 'settings_disable_filters')
    .text('◀️ Назад в меню', 'settings_back_main');

  const text = `<b>⚙️ Настройки сигналов</b>\n\n` +
    `1) Продажа: спред больше <b>${s.sellSpreadPct}%</b>\n` +
    `2) Вход: 24ч рост меньше <b>+${s.maxEntryChg24Pct}%</b>\n\n` +
    `<b>Web3 token discovery</b>\n` +
    `• Ликвидность: <b>${t.liquidityUsd[0]} — ${t.liquidityUsd[1]} USD</b>\n` +
    `• Холдеры: <b>${t.holders[0]} — ${t.holders[1]} чел.</b>\n` +
    `• Объем 24ч: <b>${t.volume24h[0]} — ${t.volume24h[1]} USD</b>\n` +
    `• Возраст: <b>${t.ageMinutes[0]} — ${t.ageMinutes[1]} мин.</b>\n\n` +
    `Выберите параметр для изменения.`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// --- Кнопки меню настроек ---
settingsComposer.callbackQuery(/^settings_edit_token_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => { });
  const field = ctx.match[1];

  if (!TOKEN_FILTER_LABELS[field]) { // Если у тебя есть этот объект с названиями
    await ctx.reply('Неизвестный фильтр.');
    return;
  }

  ctx.session.settingsStep = `tokenDiscovery.${field}`;
  await ctx.reply(`Измените фильтр "${TOKEN_FILTER_LABELS[field]}".\n\nВведите диапазон <b>через дефис</b> (например: <code>100-150000</code>).`, { parse_mode: 'HTML' });
});

settingsComposer.callbackQuery('settings_disable_filters', async (ctx) => {
  let toggleFilter = !ctx.session.isDisableFiltr;
  if (toggleFilter) {
    await ctx.answerCallbackQuery('Фильтры включены').catch(() => { });
    ctx.session.isDisableFiltr = true;
  } else {
    await ctx.answerCallbackQuery('Фильтры отключены').catch(() => { });
    ctx.session.isDisableFiltr = false;
  }
  await ctx.reply(`Фильтры ${ctx.session.isDisableFiltr ? 'отключены' : 'включены'}.`, { parse_mode: 'HTML' });
});

settingsComposer.callbackQuery('settings_back_main', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => { });
  const { mainMenuComposer } = await import('./mainMenu.mjs');
  await mainMenuComposer.command('start', ctx);
});

// --- Ввод чисел пользователем ---
settingsComposer.on('message:text', async (ctx, next) => {
  const step = ctx.session?.settingsStep;
  if (!step) return next();

  const text = ctx.message.text.trim();

  // --- ЛОГИКА ДЛЯ ДИАПАЗОНОВ (Web3 Filters) ---
  if (step.startsWith('tokenDiscovery.')) {
    const field = step.split('.')[1];
    const parts = text.split('-');

    if (parts.length !== 2) {
      return ctx.reply('❌ Неверный формат. Введите два числа через дефис, например: 10000-150000');
    }

    const min = parseFloat(parts[0].trim());
    const max = parseFloat(parts[1].trim());

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return ctx.reply('❌ Это не числа. Попробуйте еще раз (например: 100-5000).');
    }

    if (min >= max || min < 0) {
      return ctx.reply('❌ Ошибка: первое число должно быть меньше второго, и они не могут быть отрицательными.');
    }

    // Сохраняем массив
    const tokenFilters = getTokenDiscoveryFilters(ctx);
    tokenFilters[field] = [min, max];

    ctx.session.settingsStep = null;
    await ctx.reply(`✅ Диапазон успешно обновлен: <b>${min} — ${max}</b>`, { parse_mode: 'HTML' });

    // Возвращаем меню (вызови функцию показа меню)
    return showSettingsMenu(ctx);
  }

  // --- ЛОГИКА ДЛЯ ПРОЦЕНТОВ (Спред и Рост) ---
  const value = parseFloat(text); // или твоя функция parseNumber(text)

  if (!Number.isFinite(value)) {
    return ctx.reply('❌ Это не число. Введите, например: 5 или 15.5');
  }

  // Ограничиваем разумными пределами ТОЛЬКО для процентов
  if (value < 0 || value > 100) {
    return ctx.reply('❌ Процент должен быть от 0 до 100. Попробуйте снова.');
  }

  const s = getSignalSettings(ctx);
  s[step] = value; // step тут равен 'sellSpreadPct' или 'maxEntryChg24Pct'

  ctx.session.settingsStep = null;
  await ctx.reply(`✅ Значение обновлено: <b>${value}%</b>`, { parse_mode: 'HTML' });
  return showSettingsMenu(ctx);
});