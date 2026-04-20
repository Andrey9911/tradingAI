import { Composer, InlineKeyboard } from 'grammy';
import { AuthService } from '../services/authService.mjs';
import { BybitService } from '../services/bybitService.mjs';

const ASSETS_PER_PAGE = 5;

export const assetsComposer = new Composer();

// Обработка вызова из главного меню
assetsComposer.callbackQuery('menu_assets', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await showAssets(ctx);
});

// Пагинация активов
assetsComposer.callbackQuery(/^assets_page_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const page = parseInt(ctx.match[1], 10);
  ctx.session.assetsPage = page;
  await showAssets(ctx);
});

// Обновление
assetsComposer.callbackQuery('assets_refresh', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.assetsPage = 0;
  await showAssets(ctx);
});

// Выбор конкретного актива
assetsComposer.callbackQuery(/^asset_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const coin = ctx.match[1];
  await showAssetDetails(ctx, coin);
});

// Выбор периода PnL
assetsComposer.callbackQuery(/^pnl_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const coin = ctx.match[1];
  const days = parseInt(ctx.match[2], 10);
  await showPnL(ctx, coin, days);
});

// --- Вспомогательные функции ---
export async function showAssets(ctx) {
  const userId = ctx.from.id;
  let keys;
  try {
    keys = await new AuthService().getUserKeys(userId);
    
    if (!keys) {
      await ctx.reply('❌ Вы не зарегистрированы. Используйте /register');
      return;
    }
  } catch (err) {
    await ctx.reply(`Ошибка получения ключей: ${err.message}`);
    return;
  }

  const bybit = new BybitService(keys.apiKey, keys.apiSecret);
  let balances;
  try {
    // предполагаем, что метод getSpotBalances возвращает массив с полями coin, walletBalance, usdValue, change24h
    balances = await bybit.getSpotBalances();
    balances = balances
      .filter(b => parseFloat(b.walletBalance) > 0)
      .sort((a, b) => parseFloat(b.usdValue) - parseFloat(a.usdValue));
  } catch (err) {
    await ctx.reply(`Ошибка получения баланса: ${err.message}`);
    return;
  }

  const totalBalanceUSD = balances.reduce((sum, b) => sum + parseFloat(b.usdValue || 0), 0);
  // Здесь нужно вычислять реальное изменение, пока заглушка
  const change24h = 2.5;
  const changeSymbol = change24h >= 0 ? '📈' : '📉';

  const header = `💰 *Общий баланс:* ${totalBalanceUSD.toFixed(2)} USDT\n${changeSymbol} *Изменение за 24ч:* ${Math.abs(change24h).toFixed(2)}%\n\n📋 *Активы с ненулевым балансом:*`;

  const page = ctx.session.assetsPage || 0;
  const start = page * ASSETS_PER_PAGE;
  const pageBalances = balances.slice(start, start + ASSETS_PER_PAGE);

  let message = header;
  pageBalances.forEach(b => {
    message += `\n• *${b.coin}*: ${parseFloat(b.walletBalance).toFixed(4)} (≈ ${parseFloat(b.usdValue).toFixed(2)} USDT)`;
  });

  const keyboard = new InlineKeyboard();
  pageBalances.forEach(b => {
    keyboard.text(b.coin, `asset_${b.coin}`).row();
  });

  const totalPages = Math.ceil(balances.length / ASSETS_PER_PAGE);
  const navRow = [];
  if (page > 0) navRow.push(InlineKeyboard.text('◀️ Назад', `assets_page_${page - 1}`));
  if (page + 1 < totalPages) navRow.push(InlineKeyboard.text('Вперед ▶️', `assets_page_${page + 1}`));
  if (navRow.length) keyboard.row(...navRow);
  keyboard.row(InlineKeyboard.text('🔄 Обновить', 'assets_refresh'));

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  }).catch(() => {
    ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  });
}

export async function showAssetDetails(ctx, coin) {
    const userId = ctx.from.id;
    let keys;
  
    // 1. Получаем ключи пользователя
    try {
      keys = await new AuthService().getUserKeys(userId);
      if (!keys) {
        await ctx.answerCallbackQuery({ text: '❌ Вы не зарегистрированы.', show_alert: true }).catch(() => {});
        return;
      }
    } catch (err) {
      console.error('Ошибка auth:', err);
      await ctx.answerCallbackQuery({ text: '❌ Ошибка базы данных', show_alert: true }).catch(() => {});
      return;
    }
  
    // 2. Получаем данные по конкретной монете с биржи
    const bybit = new BybitService(keys.apiKey, keys.apiSecret);
    let balanceInfo;
    
    try {
      const balances = await bybit.getSpotBalances();
      // Ищем конкретную монету в массиве балансов
      balanceInfo = balances.find(b => b.coin === coin);
      
      if (!balanceInfo) {
        await ctx.answerCallbackQuery({ text: `У вас нет активов ${coin} на спотовом кошельке.`, show_alert: true }).catch(() => {});
        return;
      }
    } catch (err) {
      console.error('Ошибка bybit:', err);
      await ctx.answerCallbackQuery({ text: '❌ Ошибка API Bybit', show_alert: true }).catch(() => {});
      return;
    }
  
    // 3. Формируем данные
    const amount = parseFloat(balanceInfo.walletBalance);
    const usdValue = parseFloat(balanceInfo.usdValue || 0);
    
    // Высчитываем примерную среднюю цену монеты, если биржа не вернула её напрямую
    const currentPrice = amount > 0 ? (usdValue / amount) : 0;
  
    const text = `🪙 *Детальная информация: ${coin}*\n\n` +
                 `💰 *Ваш баланс:* ${amount.toFixed(4)} ${coin}\n` +
                 `💵 *Оценка в USD:* ≈ ${usdValue.toFixed(2)} USDT\n` +
                 `📊 *Текущая цена:* ≈ ${currentPrice.toFixed(4)} USDT\n\n` +
                 `👇 _Выберите период для просмотра PnL (Прибыль/Убыток):_`;
  
    // 4. Формируем клавиатуру
    const keyboard = new InlineKeyboard()
      .text('📊 PnL за 7 дней', `pnl_${coin}_7`)
      .text('📊 PnL за 30 дней', `pnl_${coin}_30`)
      .row()
      .text('◀️ Назад к списку активов', 'menu_assets'); // Возвращаемся в главное меню активов
  
    // 5. Обновляем сообщение
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (err) {
      // Если текст не изменился, Telegram кинет ошибку, просто гасим загрузку на кнопке
      await ctx.answerCallbackQuery().catch(() => {});
    }
}

async function showPnL(ctx, coin, days) {
  // ...
}