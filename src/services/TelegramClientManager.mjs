import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const SESSION_FILE = path.join(process.cwd(), 'session.txt');
const DEFAULT_CONNECT_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readApiConfig() {
  const apiId = Number(process.env.TELEGRAM_MTPROTO_API_ID);
  const apiHash = process.env.TELEGRAM_MTPROTO_API_HASH;
  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error('TELEGRAM_MTPROTO_API_ID must be set in .env and numeric.');
  }
  if (!apiHash) {
    throw new Error('TELEGRAM_MTPROTO_API_HASH must be set in .env.');
  }
  return { apiId, apiHash };
}

async function safeDisconnect(client) {
  try {
    await client.disconnect();
  } catch {}
}

export class TelegramClientManager {
  static lastConnectAt = 0;

  static sessionFilePath() {
    return SESSION_FILE;
  }

  static async hasSessionFile() {
    try {
      await access(SESSION_FILE);
      const text = (await readFile(SESSION_FILE, 'utf8')).trim();
      return Boolean(text);
    } catch {
      return false;
    }
  }

  static async readSessionString() {
    const text = (await readFile(SESSION_FILE, 'utf8')).trim();
    if (!text) throw new Error('session.txt is empty.');
    return text;
  }

  static async saveSessionString(sessionString) {
    const text = String(sessionString || '').trim();
    if (!text) throw new Error('Cannot save empty MTProto session.');
    await writeFile(SESSION_FILE, `${text}\n`, 'utf8');
  }

  static async waitBeforeConnect() {
    const delayMs = Number(process.env.TELEGRAM_MTPROTO_CONNECT_DELAY_MS || DEFAULT_CONNECT_DELAY_MS);
    const safeDelayMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : DEFAULT_CONNECT_DELAY_MS;
    const elapsed = Date.now() - TelegramClientManager.lastConnectAt;
    if (elapsed < safeDelayMs) await sleep(safeDelayMs - elapsed);
    TelegramClientManager.lastConnectAt = Date.now();
  }

  static async runAction(actionCallback) {
    const { apiId, apiHash } = readApiConfig();
    const session = await TelegramClientManager.readSessionString();
    return TelegramClientManager.runWithSession(session, actionCallback, { apiId, apiHash });
  }

  static async runAuthAction(actionCallback) {
    const { apiId, apiHash } = readApiConfig();
    return TelegramClientManager.runWithSession('', actionCallback, { apiId, apiHash });
  }

  static async runWithSession(sessionString, actionCallback, { apiId, apiHash } = readApiConfig()) {
    if (typeof actionCallback !== 'function') throw new Error('actionCallback must be a function.');
    await TelegramClientManager.waitBeforeConnect();
    const client = new TelegramClient(
      new StringSession(sessionString || ''),
      apiId,
      apiHash,
      { connectionRetries: 3 },
    );
    await client.connect();
    try {
      return await actionCallback(client, { apiId, apiHash });
    } finally {
      await safeDisconnect(client);
    }
  }
}
