import { Composer, InlineKeyboard } from 'grammy';
import { AuthService } from '../services/authService.mjs';
import { BybitService } from '../services/bybitService.mjs';
import { AIService } from '../services/aiService.mjs';
import { runSignalSearch } from '../composers/signals.mjs'
import { AutopostingService } from '../services/autopostingService.mjs';
import { TelegramSessionService } from '../services/telegramSessionService.mjs';
import { TradingMetricsService, summarizeTradingMetrics } from '../services/tradingMetricsService.mjs';

const ORDERS_PER_PAGE = 5;

/** Порог спреда для сигнала «рассмотреть продажу»: текущая цена выше последней покупки на X% */
const SELL_SPREAD_PCT = parseFloat(process.env.AI_SELL_SPREAD_PCT || '2');
/** Порог для «хороший момент для усреднения/докупки»: цена ниже последней покупки на X% */
const BUY_DIP_PCT = parseFloat(process.env.AI_BUY_DIP_PCT || '5');

async function createTradingPostDraft(ctx, metric) {
  if (String(process.env.TRADING_METRICS_AUTO_DRAFTS || 'true').toLowerCase() !== 'true') return null;
  const metrics = new TradingMetricsService();
  const recentMetrics = await metrics.listMetrics(30);
  const mtproto = new TelegramSessionService();
  const sessionConfig = await mtproto.getSessionConfig(ctx.from?.id);
  const channelHandle = sessionConfig?.preferredChannel?.handle;
  const pastPosts = channelHandle
    ? await mtproto.fetchRecentChannelPosts(ctx.from?.id, channelHandle, 15).catch(() => [])
    : [];
  const pendingDraft = await new AutopostingService().createTradingMetricsDraft({
    metric,
    metricsSummary: summarizeTradingMetrics(recentMetrics),
    pastPosts,
  });
  pendingDraft.ownerId = ctx.from?.id;
  const basketDraft = await metrics.addDraft(pendingDraft, metric);
  await ctx.reply(
    `🧺 SMM-агент создал draft по результату сделки и добавил его в корзину.\n` +
      `Draft ID: <code>${basketDraft.id}</code>\n` +
      `Откройте 📣 Автопостинг → 🧺 Корзина постов для одобрения.`,
    { parse_mode: 'HTML' },
  ).catch(() => {});
  return basketDraft;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const ordersComposer = new Composer();



// 1. Главное меню лимитных ордеров (вызывается из mainMenu.mjs)
export async function showLimitOrders(ctx) {
  const keyboard = new InlineKeyboard()
    .text('AI установка ордеров', 'ai_setup_orders').row()
    .text('Список лимитных ордеров', 'list_limit_orders').row()
    .text('Назад', 'orders_back_main');

  const text =
    '📊 <b>Управление лимитными ордерами</b>\n\nВыберите действие:';

  if (ctx.callbackQuery) {
    await ctx
      .editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard })
      .catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// 2. Список лимитных ордеров
ordersComposer.callbackQuery('list_limit_orders', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.ordersPage = 0;
  await showOrdersList(ctx);
});

// 3. Назад в главное меню (не `menu_*`, иначе mainMenu перехватывает раньше)
ordersComposer.callbackQuery('orders_back_main', async (ctx) => {
  const { mainMenuComposer } = await import('./mainMenu.mjs');
  mainMenuComposer.command('start',ctx);
  await ctx.answerCallbackQuery().catch(() => {});
});

async function showOrdersList(ctx) {
  const userId = ctx.from.id;
  let keys;
  try {
    keys = await new AuthService().getUserKeys(userId);
    if (!keys) return ctx.reply('❌ Вы не зарегистрированы. Используйте /register');
  } catch (err) {
    return ctx.reply(`Ошибка получения ключей: ${err.message}`);
  }

  const bybit = new BybitService(keys.apiKey, keys.apiSecret);
  let orders;
  try {
    orders = await bybit.getOpenLimitOrders();
    if (!orders.length) {
      const keyboard = new InlineKeyboard().text('Назад', 'menu_orders');
      return ctx.editMessageText('📭 У вас нет открытых лимитных ордеров.', {
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    return ctx.reply(`Ошибка получения ордеров: ${err.message}`);
  }

  const page = ctx.session.ordersPage || 0;
  const start = page * ORDERS_PER_PAGE;
  const pageOrders = orders.slice(start, start + ORDERS_PER_PAGE);

  let message = `📋 <b>Открытые лимитные ордера</b> (всего ${orders.length}):\n\n`;
  pageOrders.forEach(order => {
    message += `• <b>${order.symbol}</b> (${order.side})\n   Цена: ${order.price} | Кол-во: ${order.leavesQty}\n\n`;
  });

  const keyboard = new InlineKeyboard();
  pageOrders.forEach(order => {
    keyboard.text(`${order.symbol} (${order.side})`, `order_${order.orderId}`).row();
  });

  const totalPages = Math.ceil(orders.length / ORDERS_PER_PAGE);
  const navRow = [];
  if (page > 0) navRow.push(InlineKeyboard.text('◀️ Стр.', `orders_page_${page - 1}`));
  if (page + 1 < totalPages)
    navRow.push(InlineKeyboard.text('Стр. ▶️', `orders_page_${page + 1}`));
  if (navRow.length) keyboard.row(...navRow);

  keyboard.row(InlineKeyboard.text('🔄 Обновить', 'list_limit_orders'));
  keyboard.row(InlineKeyboard.text('Назад', 'menu_orders'));

  await ctx
    .editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard })
    .catch(() => {
      ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
    });
}

// AI: метрики по монетам с положительным балансом, спред от последней покупки
ordersComposer.callbackQuery('ai_setup_orders', async (ctx) => {
  await ctx.answerCallbackQuery('ИИ анализирует активы…').catch(() => {});
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const userId = ctx.from.id;
  let keys;
  try {
    keys = await new AuthService().getUserKeys(userId);
    if (!keys) {
      return ctx.reply('❌ Вы не зарегистрированы. Используйте /register');
    }
  } catch (err) {
    return ctx.reply(`Ошибка ключей: ${err.message}`);
  }

  const bybit = new BybitService(keys.apiKey, keys.apiSecret,false);
  const aiService = new AIService();

  try {
    let balances = await bybit.getSpotBalances();
    balances = balances.filter(
      b =>
        parseFloat(b.walletBalance) > 0 &&
        !['USDT', 'USDC', 'USD'].includes(b.coin),
    );

    const analysis = [];
    for (const asset of balances) {
      
      const symbol = asset.coin + 'USDT';
      const currentPrice = await bybit.getCurrentPrice(symbol);

      // ВМЕСТО getLastBuyPrice вызываем наш новый сборщик метрик
      const metrics = await bybit.get30dTradeMetrics(asset.coin);

      if (metrics && currentPrice) {
        /**
         * Важно:
         * - avgBuyPrice (30d) — средняя цена ПОКУПОК за 30 дней, она не учитывает частичные продажи.
         * - avgCostRemaining30d — себестоимость ОСТАТКА позиции внутри 30 дней (после продаж), если её можно определить.
         * - если в 30d продавали больше чем покупали (soldFromOlderPosition=true), значит продавали старую позицию,
         *   и 30d cost basis для остатка определить нельзя → используем avgBuyPrice как ориентир и помечаем предупреждение.
         */
        const basisPrice =
          metrics.avgCostRemaining30d != null
            ? metrics.avgCostRemaining30d
            : metrics.avgBuyPrice;

        if (!basisPrice || basisPrice <= 0) {
          await sleep(200);
          continue;
        }

        // 1) Спред относительно себестоимости (остатка), либо avgBuyPrice как fallback
        const spread = ((currentPrice - basisPrice) / basisPrice) * 100;

        // 2) PnL за 30d, считаем только по чистой позиции, собранной в 30d (чтобы не подмешивать старые холды)
        const qty30d = metrics.remainingQty30d != null ? Math.max(0, metrics.remainingQty30d) : null;
        const currentHoldingsValue30d = qty30d != null ? qty30d * currentPrice : null;
        const realPnlUsd =
          qty30d != null && metrics.totalInvested > 0
            ? (currentHoldingsValue30d + metrics.totalRealized) - metrics.totalInvested
            : null;
        const realPnlPct =
          realPnlUsd != null && metrics.totalInvested > 0
            ? (realPnlUsd / metrics.totalInvested) * 100
            : null;

        // 3) Цена, при которой продажа будет с профитом X% относительно basisPrice
        const targetSellPrice = basisPrice * (1 + SELL_SPREAD_PCT / 100);

        analysis.push({
          coin: asset.coin,
          symbol,
          spread,
          realPnlPct,
          realPnlUsd,
          basisPrice,
          targetSellPrice,
          avgBuyPrice: metrics.avgBuyPrice,
          avgSellPrice: metrics.avgSellPrice,
          soldFromOlderPosition: Boolean(metrics.soldFromOlderPosition),
          qty30d,
          currentPrice,
          walletBalance: asset.walletBalance,
          usdValue: asset.usdValue,
          change24h: asset.change24h,
        });
      }
      await sleep(200);
    }

    if (analysis.length === 0) {
      const kb = new InlineKeyboard().text('Назад', 'menu_orders');
      return ctx.editMessageText(
        '🤖 Недостаточно данных: нет спот-истории покупок по вашим монетам (или нет пар USDT).',
        { reply_markup: kb },
      );
    }

    const sellCandidates = analysis.filter(a => a.spread >= SELL_SPREAD_PCT);
    const buyCandidates = analysis.filter(a => a.spread <= -BUY_DIP_PCT);

    const aiComment = await aiService.getPortfolioAdvice(
      sellCandidates,
      buyCandidates,
      { sellPct: SELL_SPREAD_PCT, buyPct: BUY_DIP_PCT },
    );
    // Если aiComment пришел как null или undefined (на случай если в сервисе не обработано)
    const safeComment = aiComment || "Совет временно недоступен.";
    const actionKeyboard = new InlineKeyboard();

    let msg = '🤖 <b>AI-мониторинг спреда</b>\n';
    msg += `<i>Пороги: продажа ≥ ${SELL_SPREAD_PCT}%, докупка/усреднение ≤ −${BUY_DIP_PCT}% к последней покупке</i>\n\n`;
    msg += `<b>Вердикт ИИ</b>\n${escapeHtml(aiComment)}\n\n`;
    msg += '────────────\n';

    if (sellCandidates.length > 0) {
      msg += `<b>📈 Сигнал к продаже</b> (цена выросла от последней покупки на ≥ ${SELL_SPREAD_PCT}%):\n`;
      sellCandidates.forEach(c => {
        msg += `🔸 <b>${c.coin}</b>  🟩 Спред: <b>+${c.spread.toFixed(2)}%</b>\n`;
        if (c.soldFromOlderPosition) {
          msg += `├ ⚠️ В 30d были чистые продажи (продавали старую позицию). Себестоимость остатка по 30d неточная.\n`;
        }
        if (c.realPnlPct != null && c.realPnlUsd != null) {
          msg += `├ PnL (30d, только net позиции): <b>${c.realPnlPct > 0 ? '+' : ''}${c.realPnlPct.toFixed(2)}%</b> (~${c.realPnlUsd.toFixed(2)} USDT)\n`;
        }
        msg += `├ Себестоимость (basis): <code>${c.basisPrice.toFixed(10)}</code> ➡️ Сейчас: <code>${c.currentPrice}</code>\n`;
        msg += `├ Цена для +${SELL_SPREAD_PCT}%: <code>${c.targetSellPrice.toFixed(10)}</code>\n`;
        msg += `└ Баланс: ~${c.usdValue.toFixed(2)} USDT  |  24ч: ${c.change24h.toFixed(2)}%\n\n`;

        actionKeyboard
            .text(`🟢 Купить ${c.coin}`, `trade_buy_${c.coin}`)
            .text(`🔴 Продать ${c.coin}`, `trade_sell_${c.coin}`)
            .row();
      });
      msg += '\n';
    }

    if (buyCandidates.length > 0) {
      msg += `<b>📉 Удачный момент для покупки / усреднения</b> (цена ниже последней покупки на ≥ ${BUY_DIP_PCT}%):\n`;
      buyCandidates.forEach(d => {
        // ИСПОЛЬЗУЕМ ПРАВИЛЬНЫЕ КЛЮЧИ
        msg += `🔹 <b>${d.coin}</b>  🔻 <b>${d.spread.toFixed(2)}%</b>\n`;
        msg += `├ Себестоимость (basis): <code>${d.basisPrice.toFixed(10)}</code> ➡️ Сейчас: <code>${d.currentPrice}</code>\n`;
        // УБРАЛИ PROMISE, ОСТАВИЛИ ТОЛЬКО УЖЕ СОХРАНЕННОЕ ЗНАЧЕНИЕ d.change24h
        msg += `└ Баланс: ~${d.usdValue.toFixed(2)} USDT  |  24ч: ${d.change24h.toFixed(2)}%\n\n`;

        actionKeyboard
        .text(`🟢 Купить ${d.coin}`, `trade_buy_${d.coin}`)
        .text(`🔴 Продать ${d.coin}`, `trade_sell_${d.coin}`)
        .row();
      });
      msg += '\n';
    }

    if (!sellCandidates.length && !buyCandidates.length) {
      msg +=
        `<b>Без сильных сигналов</b> по заданным порогам. Спред от последней покупки в пределах нормы.\n`;
    }
    // Базовые кнопки в самом низу
    actionKeyboard.row().text('🔄 Обновить данные', 'refresh_ai_signals');
    actionKeyboard.row().text('🔙 Назад', 'menu_orders');
    
    await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: actionKeyboard });
  } catch (err) {
    console.error(err);
    await ctx.reply('❌ Ошибка AI-агента. Проверьте логи и ключи API.');
  }
});

// Обработка кнопки "Купить"
ordersComposer.callbackQuery(/^trade_buy_(.+)$/, async (ctx) => {
  const coin = ctx.match[1];
  await ctx.answerCallbackQuery();
  
  // Создаем мини-меню для выбора объема покупки
  const kb = new InlineKeyboard()
    .text('10% от USDT', `exec_buy_${coin}_10`)
    .text('25% от USDT', `exec_buy_${coin}_25`)
    .text('50% от USDT', `exec_buy_${coin}_50`)
    .row()
    .text('❌ Отмена', 'delete_msg');

  await ctx.reply(`🛒 <b>Покупка ${coin}</b>\n\nВыберите, на какую часть от свободных USDT совершить покупку по рынку:`, {
    parse_mode: 'HTML',
    reply_markup: kb
  });
});

// Обработка кнопки "Продать"
ordersComposer.callbackQuery(/^trade_sell_(.+)$/, async (ctx) => {
  const coin = ctx.match[1];
  await ctx.answerCallbackQuery();
  
  // Создаем мини-меню для выбора объема продажи
  const kb = new InlineKeyboard()
    .text('25% позиции', `exec_sell_${coin}_25`)
    .text('50% позиции', `exec_sell_${coin}_50`)
    .text('100% позиции', `exec_sell_${coin}_100`)
    .row()
    .text('❌ Отмена', 'delete_msg');

  await ctx.reply(`📉 <b>Продажа ${coin}</b>\n\nКакую часть вашей позиции продать по рынку?`, {
    parse_mode: 'HTML',
    reply_markup: kb
  });
});

// Вспомогательная кнопка для закрытия меню выбора процентов
ordersComposer.callbackQuery('delete_msg', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
});

// Выполнение покупки
ordersComposer.callbackQuery(/^exec_buy_(.+)_(\d+)$/, async (ctx) => {
  const coin = ctx.match[1];
  const userId = ctx.from.id;
  const percent = parseInt(ctx.match[2], 10);
  
  await ctx.answerCallbackQuery({ text: `⏳ Отправляю ордер на покупку ${coin}...` });
  
  // 1. Получаем ключи и инициализируем сервис
  const keys = await new AuthService().getUserKeys(userId);
  if (!keys) return ctx.reply('❌ Ошибка авторизации.');
  const bybit = new BybitService(keys.apiKey, keys.apiSecret);

  // 2. Считаем сумму покупки
  const freeUsdt = await bybit.getFreeUSDT();
  if (freeUsdt < 1) {
      return ctx.reply('❌ Недостаточно USDT для совершения сделки (минимум 1 USDT).');
  }

  const amountToSpend = (freeUsdt * (percent / 100)).toFixed(2);
  
  if (parseFloat(amountToSpend) < 1) {
      return ctx.reply(`❌ Сумма покупки (${amountToSpend} USDT) слишком мала.`);
  }

  // 3. Выполняем ордер
  const order = await bybit.placeMarketBuyOrder(coin, amountToSpend);
  const metric = await new TradingMetricsService().recordTrade({
    side: 'Buy',
    coin,
    symbol: `${coin}USDT`,
    percent,
    spentUsdt: amountToSpend,
    order,
    source: 'orders.exec_buy',
  });

  await ctx.editMessageText(
    `✅ <b>Ордер исполнен!</b>\n\n` +
    `Монета: <b>${coin}</b>\n` +
    `Затрачено: <b>${amountToSpend} USDT</b> (${percent}% от свободного баланса)\n` +
    `ID ордера: <code>${order.orderId}</code>`,
    { parse_mode: 'HTML' }
  );
  await createTradingPostDraft(ctx, metric);
});

// Выполнение продажи
// Выполнение продажи
ordersComposer.callbackQuery(/^exec_sell_(.+)_(\d+)$/, async (ctx) => {
  const coin = ctx.match[1];
  const percent = parseInt(ctx.match[2], 10);
  const userId = ctx.from.id;
  const symbol = coin + 'USDT';

  try {
    await ctx.answerCallbackQuery({ text: `⏳ Отправляю ордер на продажу ${coin}...` });

    const keys = await new AuthService().getUserKeys(userId);
    if (!keys) return ctx.reply('❌ Ошибка авторизации.');
    const bybit = new BybitService(keys.apiKey, keys.apiSecret);

    // 1. Получаем точный баланс монеты (не USDT, а самой крипты)
    const balanceStr = await bybit.getBalanceByCoin(coin);
    const balance = parseFloat(balanceStr);

    if (balance <= 0) {
      return ctx.reply(`❌ Недостаточно ${coin} на балансе.`);
    }

    // 2. Считаем, сколько монет продать
    const qtyToSell = balance * (percent / 100);

    // Округляем до 5 знаков, чтобы избежать ошибок слишком длинных дробей на бирже
    // (Используем Math.floor, чтобы случайно не попытаться продать больше, чем есть из-за округления вверх)
    const formattedQty = (Math.floor(qtyToSell * 100000) / 100000).toString();

    // 3. Выполняем ордер
    const order = await bybit.placeMarketSellOrder(symbol, formattedQty);
    const metric = await new TradingMetricsService().recordTrade({
      side: 'Sell',
      coin,
      symbol,
      percent,
      quantity: formattedQty,
      order,
      source: 'orders.exec_sell',
    });

    await ctx.editMessageText(
      `✅ <b>Ордер исполнен!</b>\n\n` +
      `Монета: <b>${coin}</b>\n` +
      `Продано: <b>${formattedQty} ${coin}</b> (${percent}% от позиции)\n` +
      `ID ордера: <code>${order.orderId}</code>`,
      { parse_mode: 'HTML' }
    );
    await createTradingPostDraft(ctx, metric);
  } catch (err) {
    console.error('Ошибка при продаже:', err);
    await ctx.reply(`❌ Ошибка исполнения: ${err.message}`);
  }
});

ordersComposer.callbackQuery(/^orders_page_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const page = parseInt(ctx.match[1], 10);
  ctx.session.ordersPage = page;
  await showOrdersList(ctx);
});

ordersComposer.callbackQuery('orders_refresh', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.ordersPage = 0;
  await showOrdersList(ctx);
});

ordersComposer.callbackQuery(/^order_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  await showOrderDetails(ctx, orderId);
});

async function showOrderDetails(ctx, orderId) {
  await ctx.answerCallbackQuery().catch(() => {});
  const userId = ctx.from.id;
  let keys;
  try {
    keys = await new AuthService().getUserKeys(userId);
    if (!keys) return ctx.reply('❌ Вы не зарегистрированы.');
  } catch (err) {
    return ctx.reply(`Ошибка: ${err.message}`);
  }

  const bybit = new BybitService(keys.apiKey, keys.apiSecret);
  const order = await bybit.getOrderById(orderId);
  const kb = new InlineKeyboard().text('Назад к списку', 'list_limit_orders');

  if (!order) {
    return ctx
      .editMessageText('Ордер не найден.', { reply_markup: kb })
      .catch(() => ctx.reply('Ордер не найден.', { reply_markup: kb }));
  }

  const text =
    `📌 <b>Ордер</b>\n` +
    `Пара: ${order.symbol}\n` +
    `Сторона: ${order.side}\n` +
    `Тип: ${order.orderType}\n` +
    `Цена: ${order.price}\n` +
    `Кол-во: ${order.qty}\n` +
    `Остаток: ${order.leavesQty}\n` +
    `Статус: ${order.orderStatus}`;

  await ctx
    .editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
}

// Обработчик нажатия на "Обновить"
ordersComposer.callbackQuery('refresh_ai_signals', async (ctx) => {
  try {
    // 1. Показываем "часики" на кнопке, чтобы юзер видел, что процесс пошел
    await ctx.answerCallbackQuery({ text: '⏳ Обновляю аналитику...' });

    // 2. Визуально уведомляем об обновлении (опционально)
    await ctx.editMessageCaption ? 
        await ctx.editMessageText('🔄 Идет повторный анализ рынка...') : 
        null;

    // 3. Вызываем вашу функцию поиска сигналов
    // ВАЖНО: передайте ctx, чтобы функция знала, куда отвечать
    await runSignalSearch(ctx); 

  } catch (err) {
    console.error('Ошибка обновления сигналов:', err);
    await ctx.reply('❌ Не удалось обновить данные. Попробуйте позже.');
  }
});