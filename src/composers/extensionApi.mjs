import { Router } from 'express';
import { runUserSignalAnalysis } from './signals.mjs';
import { supabase } from '../db/supabaseClient.mjs';

function requireExtensionToken(req, res, next) {
  const expected = process.env.EXTENSION_API_TOKEN;
  if (!expected) return res.status(503).json({ message: 'EXTENSION_API_TOKEN не задан на сервере.' });
  if (req.get('X-Extension-Token') !== expected) return res.status(401).json({ message: 'Неверный токен расширения.' });
  next();
}
function botContext(bot, userId) {
  const chat = { id: userId };
  return {
    from: { id: userId }, chat, session: {},
    api: bot.api,
    reply: (text, options) => bot.api.sendMessage(userId, text, options),
  };
}
export function createExtensionApiRouter(bot) {
  const router = Router();
  router.use(requireExtensionToken);
  router.post('/api/extension/analyze', async (req, res) => {
    const userId = Number(process.env.OWNER_ID);
    const { ticker, description = '', direction = null, typeCoin = 'native', aiVerdict = '', macroData = null } = req.body || {};
    if (!userId || !ticker || !['native', 'token'].includes(typeCoin)) return res.status(400).json({ message: 'Некорректные параметры анализа.' });
    res.status(202).json({ accepted: true, message: 'Анализ запущен в Telegram.' });
    runUserSignalAnalysis(botContext(bot, userId), ticker, description, direction, typeCoin, { aiVerdict, macroData }).catch((error) => console.error('extension analysis:', error));
  });
  router.post('/api/extension/vision', async (req, res) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const { image, ticker = '' } = req.body || {};
    if (!apiKey) return res.status(503).json({ message: 'На сервере не задан OPENROUTER_API_KEY для Vision AI.' });
    if (typeof image !== 'string' || !/^data:image\/jpeg;base64,/.test(image) || image.length > 7_500_000) {
      return res.status(400).json({ message: 'Нужен JPEG-снимок вкладки размером до 5 МБ.' });
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 55_000);
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OPENROUTER_VISION_MODEL || 'qwen/qwen2.5-vl-72b-instruct:free',
          messages: [{ role: 'user', content: [
            { type: 'text', text: `Проанализируй только видимую торговую диаграмму ${ticker ? `для ${ticker}` : ''}. Кратко на русском: тренд, ключевые уровни, паттерны, риск и нейтральный вердикт. Не давай финансовых гарантий.` },
            { type: 'image_url', image_url: { url: image } },
          ] }], max_tokens: 700,
        }),
      });
      clearTimeout(timer);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return res.status(502).json({ message: payload.error?.message || 'Vision API временно недоступен.' });
      const verdict = payload.choices?.[0]?.message?.content;
      if (!verdict) return res.status(502).json({ message: 'Vision API не вернул текстовый вердикт.' });
      res.json({ verdict });
    } catch (error) {
      res.status(502).json({ message: error.name === 'AbortError' ? 'Vision AI не ответил за 55 секунд.' : 'Не удалось запросить Vision AI.' });
    }
  });
  router.get('/api/extension/signals', async (req, res) => {
    const userId = Number(req.query.telegramUserId);
    if (!userId || userId !== Number(process.env.OWNER_ID)) return res.status(403).json({ message: 'Доступен только архив владельца.' });
    const query = String(req.query.query || '').trim();
    let request = supabase.from('trade_signals').select('id,symbol,side,verdict,risk,ai_reason,created_at,status').eq('telegram_user_id', userId).eq('status', 'analyzed').order('created_at', { ascending: false }).limit(100);
    if (query) request = request.or(`symbol.ilike.%${query}%,verdict.ilike.%${query}%`);
    const { data, error } = await request;
    if (error) return res.status(500).json({ message: 'Не удалось получить архив.' });
    res.json({ signals: data || [] });
  });
  return router;
}
