import { Composer, Keyboard, InlineKeyboard } from 'grammy';
import { showAssets } from './assets.mjs';
import { showLimitOrders } from './orders.mjs';
import { runSignalSearch, runUserSignalAnalysis } from './signals.mjs';
import { showSettingsMenu } from './settings.mjs';
// import { runAiSignal } from './aiSignalComposer.mjs';
import { runWeb3Discovery } from './web3Discovery.mjs';
import { showAutopostingMenu } from './autoposting.mjs';


export const mainMenuComposer = new Composer();

export function buildMainMenuKeyboard() {
  return new Keyboard()
    .text('💰 Активы')
    .text('📊 Лимитные ордера').row()
    .text('🔍 Поиск сигналов')
    .text('⚙️ Настройки')
    .text('🧬 Web3 top-10')
    .text('📣 Автопостинг').row()
    .text('⚡ Позиции (фьючи)')
    .resized();
}




/** Отправить приветствие и reply-клавиатуру главного меню */
export async function sendMainMenu(ctx) {
  const mtproto = ctx.session?.telegramMtprotoReady ? '\n🔐 MTProto session восстановлена.' : '';
  await ctx.reply(`👋 Торговый ассистент Bybit${mtproto}\nВыберите действие:`, {
    reply_markup: buildMainMenuKeyboard(),
  });
}

// Команда /start
mainMenuComposer.command('start', async (ctx) => {
  await sendMainMenu(ctx);
});



// Обработка нажатий на кнопки главного меню
mainMenuComposer.on('message:text', async (ctx, next) => {
  if (ctx.session && ctx.session.awaitingSignal) {
    ctx.session.awaitingSignal = false; // Reset the state
    const text = ctx.message.text.trim();
    
    // Ищем направление
    let direction = null;
    if (/\bshort\b/i.test(text) || /\bшорт\b/i.test(text)) direction = 'SHORT';
    else if (/\blong\b/i.test(text) || /\bлонг\b/i.test(text)) direction = 'LONG';

    // Разделяем сообщение на строки
    const lines = text.split('\n');
    // Очищаем первую строку от эмодзи и спецсимволов для надежного поиска тикера
    const firstLineClean = lines[0].replace(/[^\w\s-]/gi, '').trim();
    const ticker = firstLineClean.split(/\s+/)[0];
    
    // Оставляем весь текст как описание, чтобы ИИ видел все детали (плечо, цены и т.д.)
    const description = text;
    
    console.log('Parsed signal:', ticker, direction);

    await runUserSignalAnalysis(ctx, ticker, description, direction);
    return;
  }

  if (ctx.message.text === '💰 Активы') {
    await showAssets(ctx);
  }
  if (ctx.message.text === '📊 Лимитные ордера') {
    await showLimitOrders(ctx);
  }
  if (ctx.message.text === '🔍 Поиск сигналов') {
    const inlineKeyboard = new InlineKeyboard()
      .text('📈 Анализ рынка', 'menu_signals-market').row()
      .text('🔎 Анализ сигнала', 'menu_signals-analyze');

    await ctx.reply('Выберите тип поиска сигналов:', {
      reply_markup: inlineKeyboard
    });
  }
  if (ctx.message.text === '⚙️ Настройки') {
    await showSettingsMenu(ctx);
  }



  if (ctx.message.text === '🧠 AI-аналитика') {
    await ctx.reply('🤖 AI-аналитика в разработке. Скоро вы сможете получать прогнозы по выбранным монетам.');
  }
  if (ctx.message.text === '🧬 Web3 top-10') {
    await runWeb3Discovery(ctx);
  }
  if (ctx.message.text === '📣 Автопостинг') {
    await showAutopostingMenu(ctx);
  }
  if (ctx.message.text === '⚡ Позиции (фьючи)') {
    await ctx.reply('⚡ Фьючерсные позиции — функционал в разработке (скоро).');
  }
  if (ctx.message.text === '🤖 AI анализ мемок') {
    // await runAiSignal(ctx);  //TODO: Добавить обработку мемок
    await ctx.reply('🤖 AI анализ мемок');

    return;
  }
  return next();
});
mainMenuComposer.callbackQuery(/^menu_/, async (ctx) => {
  // Важно: ответ на callback нужно отправлять быстро.
  // Иначе Telegram успевает "протухнуть" query и grammy кидает 400.
  await ctx.answerCallbackQuery().catch(() => { });

  const action = ctx.callbackQuery.data.split('_')[1];
  console.log(action);

  switch (action) {
    case 'assets':
      await ctx.reply('Загрузка активов...');
      await showAssets(ctx);
      // Передаём управление композеру assets, но вызываем функцию напрямую?
      // Удобнее вызвать метод, который уже есть в другом композере.
      // Для этого можно импортировать вспомогательную функцию или использовать контекст.
      // В данном случае мы просто отвечаем, что переход обрабатывается другим композером.
      // Однако чтобы не плодить лишние обработчики, можно сделать так:
      // await ctx.reply('Загрузка активов...');
      // и в assetsComposer будет обработчик на что-то другое.
      // Но проще: мы можем не обрабатывать здесь, а в assetsComposer сделать callback на 'menu_assets'.
      // Поэтому здесь оставим пустым, а реальную логику перенесём в assetsComposer.
      break;
    case 'orders':
      await showLimitOrders(ctx);
      break;
    case 'signals-market':
      await runSignalSearch(ctx);
      break;
    case 'signals-analyze':
      ctx.session.awaitingSignal = true;
      await ctx.reply('Отправьте мне сообщение с сигналом.\n\nПервая строка — тикер (например, BTC).\nОстальные строки — описание или ваш комментарий.');
      break;
    case 'settings':
      await showSettingsMenu(ctx);
      break;
    case 'ai':
      await ctx.reply('🤖 AI-аналитика в разработке. Скоро вы сможете получать прогнозы по выбранным монетам.');
      break;
    case 'web3':
      await runWeb3Discovery(ctx);
      break;
    case 'autoposting':
      await showAutopostingMenu(ctx);
      break;
    case 'positions':
      await ctx.reply('⚡ Фьючерсные позиции — функционал в разработке (скоро).');
      break;
  }
});