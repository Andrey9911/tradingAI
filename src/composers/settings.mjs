import { Composer, InlineKeyboard } from 'grammy';

export const settingsComposer = new Composer();

const DEFAULT_SIGNAL_SETTINGS = {
  sellSpreadPct: parseFloat(process.env.SIGNAL_SELL_SPREAD_PCT || '5'),
  maxEntryChg24Pct: parseFloat(process.env.SIGNAL_MAX_ENTRY_CHG24_PCT || '15'),
  holdSkipUsd: parseFloat(process.env.SIGNAL_HOLD_SKIP_USD || '10'),
};

function getSignalSettings(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.signalSettings) ctx.session.signalSettings = { ...DEFAULT_SIGNAL_SETTINGS };

  // Подмешиваем значения из env, если ключей не хватает.
  ctx.session.signalSettings.sellSpreadPct ??= DEFAULT_SIGNAL_SETTINGS.sellSpreadPct;
  ctx.session.signalSettings.maxEntryChg24Pct ??= DEFAULT_SIGNAL_SETTINGS.maxEntryChg24Pct;
  ctx.session.signalSettings.holdSkipUsd ??= DEFAULT_SIGNAL_SETTINGS.holdSkipUsd;

  return ctx.session.signalSettings;
}

function parseNumber(input) {
  // Позволяем ввод вида: "15", "15.5", "+15%", "15,2"
  const normalized = String(input).replace(',', '.').trim();
  const cleaned = normalized.replace(/[^0-9.+-]/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

export async function showSettingsMenu(ctx) {
  const s = getSignalSettings(ctx);
  const keyboard = new InlineKeyboard()
    .text(`📈 Спред продажи больще ${s.sellSpreadPct}%`, 'settings_edit_sellSpreadPct')
    .text(`📉 Вход: 24ч рост меньше +${s.maxEntryChg24Pct}%`, 'settings_edit_maxEntryChg24Pct')
    .row()
    .text('◀️ Назад в меню', 'settings_back_main');

  const text = `<b>⚙️ Настройки сигналов</b>\n\n` +
    `1) Продажа: спред больще <b>${s.sellSpreadPct}%</b>\n` +
    `2) Вход: 24ч рост меньше <b>+${s.maxEntryChg24Pct}%</b>\n\n` +
    `Выберите параметр и отправьте новое число в чате.`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// --- Кнопки меню настроек ---
settingsComposer.callbackQuery('settings_edit_sellSpreadPct', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.settingsStep = 'sellSpreadPct';
  await ctx.reply('Измените значение спреда продажи (например: 5 или 7.5).');
});

settingsComposer.callbackQuery('settings_edit_maxEntryChg24Pct', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.settingsStep = 'maxEntryChg24Pct';
  await ctx.reply('Измените максимум роста за 24ч для входа (например: 15).');
});

settingsComposer.callbackQuery('settings_back_main', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const { mainMenuComposer } = await import('./mainMenu.mjs');
  await mainMenuComposer.command('start',ctx);
});

// --- Ввод чисел пользователем ---
settingsComposer.on('message:text', async (ctx, next) => {
  const step = ctx.session?.settingsStep;
  if (!step) return next();

  const value = parseNumber(ctx.message.text);
  if (!Number.isFinite(value)) {
    await ctx.reply('Это не число. Введите, например: 5 или 15.5');
    return;
  }

  // Ограничиваем разумными пределами.
  if (value < 0 || value > 100) {
    await ctx.reply('Число вне диапазона 0..100. Попробуйте снова.');
    return;
  }

  const s = getSignalSettings(ctx);
  s[step] = value;
  ctx.session.settingsStep = null;

  await showSettingsMenu(ctx);
  return await next();
});

