import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { TelegramSessionService, verifyTelegramWebAppInitData } from '../services/telegramSessionService.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..', '..');
const MINIAPP_HTML_PATH = path.join(ROOT_DIR, 'public', 'telegram-auth-miniapp.html');

export function createTelegramAuthMiniAppRouter() {
  const router = Router();
  const service = new TelegramSessionService();

  router.get('/telegram-auth', async (_req, res, next) => {
    try {
      res.type('html').send(await readFile(MINIAPP_HTML_PATH, 'utf8'));
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/telegram-auth/start', async (req, res) => {
    try {
      const auth = verifyTelegramWebAppInitData(req.body?.initData);
      const telegramId = auth?.userId || req.body?.telegramId;
      const result = await service.startLogin({
        telegramId,
        phoneNumber: req.body?.phoneNumber,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ status: 'error', message: err.message });
    }
  });

  router.post('/api/telegram-auth/verify', async (req, res) => {
    try {
      const auth = verifyTelegramWebAppInitData(req.body?.initData);
      const telegramId = auth?.userId || req.body?.telegramId;
      const result = await service.verifyLogin({
        telegramId,
        code: req.body?.code,
        password: req.body?.password,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ status: 'error', message: err.message });
    }
  });

  return router;
}
