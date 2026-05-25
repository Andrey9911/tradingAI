import { Composer } from 'grammy';
import { AuthService } from '../services/authService.mjs';
import { BybitService } from '../services/bybitService.mjs';

export const authComposer = new Composer();

// Обработка команды /register
authComposer.command('register', async (ctx) => {
  ctx.session.step = 'wait_api_key';
  await ctx.reply('Отправьте ваш API Key:');
});

// Обработка текстовых сообщений (только если есть активный шаг)
authComposer.on('message:text', async (ctx, next) => {
  const step = ctx.session.step;
  if (!step) {
    // Если нет шага, передаём управление дальше (если есть другие обработчики)
    return await next();
    
  }

  const text = ctx.message.text.trim();

  if (step === 'wait_api_key') {
    ctx.session.tempKeys.apiKey = text;
    ctx.session.step = 'wait_api_secret';
    await ctx.reply('Теперь отправьте ваш API Secret:');
  } else if (step === 'wait_api_secret') {
    ctx.session.tempKeys.apiSecret = text;
    const { apiKey, apiSecret } = ctx.session.tempKeys;

    // Проверка ключей
    try {
      const testService = new BybitService(apiKey, apiSecret);
      await testService.getBalanceByCoin('USDT');
    } catch (err) {
      await ctx.reply(`❌ Ошибка проверки ключей: ${err.message}. Попробуйте /register заново.`);
      ctx.session.step = null;
      ctx.session.tempKeys = {};
      return;
    }

    // Сохраняем в БД
    try {
      await new AuthService().registerUser(ctx.from.id, apiKey, apiSecret);
      await ctx.reply('✅ API ключи успешно сохранены!');
    } catch (error) {
      await ctx.reply(`❌ Ошибка сохранения: ${error.message}`);
    } finally {
      ctx.session.step = null;
      ctx.session.tempKeys = {};
    }
  }
});