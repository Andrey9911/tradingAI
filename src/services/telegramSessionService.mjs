import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { encrypt, decrypt } from '../utils/encryption.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..', '..');
const DEFAULT_SESSION_FILE = path.join(ROOT_DIR, 'data', 'telegram-mtproto-session.enc.json');
const TARGET_CHANNELS = ['aimodelingagency', 'mypublicgroupai'];

function normalizeId(value) {
  return String(value ?? '').trim();
}

function normalizeUsername(value) {
  return String(value ?? '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').toLowerCase();
}

function normalizePhone(value) {
  const phone = String(value ?? '').trim();
  return phone.startsWith('+') ? phone : `+${phone}`;
}

function encrypted(value) {
  return encrypt(String(value ?? ''));
}

function decrypted(value, fallback = '') {
  return value ? decrypt(value) : fallback;
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function publicChannelInfo(chat) {
  const username = normalizeUsername(chat?.username);
  return {
    id: String(chat?.id ?? ''),
    title: String(chat?.title || chat?.firstName || username || '').trim(),
    username,
    handle: username ? `@${username}` : String(chat?.id ?? ''),
  };
}

function pickPreferredChannel(channels) {
  return TARGET_CHANNELS
    .map((target) => channels.find((channel) => channel.username === target))
    .find(Boolean) || null;
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function verifyTelegramWebAppInitData(initData, botToken = process.env.API_KEY) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!timingSafeEqualText(calculated, hash)) return null;
  const user = safeJsonParse(params.get('user') || '{}', {});
  return {
    userId: normalizeId(user.id),
    username: user.username || '',
    authDate: params.get('auth_date') || '',
  };
}

export class TelegramSessionService {
  constructor({ sessionFile = process.env.TELEGRAM_MTPROTO_SESSION_FILE || DEFAULT_SESSION_FILE } = {}) {
    this.sessionFile = path.isAbsolute(sessionFile) ? sessionFile : path.join(ROOT_DIR, sessionFile);
  }

  async readStore() {
    try {
      const text = await readFile(this.sessionFile, 'utf8');
      return safeJsonParse(text, { version: 1, sessions: {}, pending: {} });
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, sessions: {}, pending: {} };
      throw err;
    }
  }

  async writeStore(store) {
    await mkdir(path.dirname(this.sessionFile), { recursive: true });
    await writeFile(this.sessionFile, JSON.stringify(store, null, 2), 'utf8');
  }

  async hasSession(telegramId) {
    const store = await this.readStore();
    return Boolean(store.sessions?.[normalizeId(telegramId)]?.session);
  }

  async getSessionConfig(telegramId) {
    const store = await this.readStore();
    const row = store.sessions?.[normalizeId(telegramId)];
    if (!row) return null;
    return {
      telegramId: normalizeId(telegramId),
      apiId: row.apiId,
      apiHash: decrypted(row.apiHash),
      session: decrypted(row.session),
      phoneNumber: decrypted(row.phoneNumber),
      preferredChannel: row.preferredChannel || null,
      channels: row.channels || [],
      authorizedAt: row.authorizedAt,
    };
  }

  async startLogin({ telegramId, apiId, apiHash, phoneNumber }) {
    const ownerId = normalizeId(process.env.OWNER_ID);
    const userId = normalizeId(telegramId);
    if (ownerId && userId !== ownerId) throw new Error('Only OWNER_ID can authorize MTProto session.');
    if (!userId) throw new Error('ID_TELEGRAM is required.');
    if (!apiId || !Number.isFinite(Number(apiId))) throw new Error('TELEGRAM_MTPROTO_API_ID must be numeric.');
    if (!apiHash) throw new Error('TELEGRAM_MTPROTO_API_HASH is required.');
    if (!phoneNumber) throw new Error('Phone number is required.');

    const phone = normalizePhone(phoneNumber);
    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, { connectionRetries: 3 });
    await client.connect();
    try {
      const sent = await client.sendCode({ apiId: Number(apiId), apiHash }, phone);
      const store = await this.readStore();
      store.pending ??= {};
      store.pending[userId] = {
        apiId: Number(apiId),
        apiHash: encrypted(apiHash),
        phoneNumber: encrypted(phone),
        phoneCodeHash: encrypted(sent.phoneCodeHash),
        isCodeViaApp: Boolean(sent.isCodeViaApp),
        createdAt: new Date().toISOString(),
      };
      await this.writeStore(store);
      return { status: 'code_required', isCodeViaApp: Boolean(sent.isCodeViaApp) };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  async verifyLogin({ telegramId, code, password = '' }) {
    const userId = normalizeId(telegramId);
    const store = await this.readStore();
    const pending = store.pending?.[userId];
    if (!pending) throw new Error('No pending Telegram login. Start authorization first.');
    if (!code) throw new Error('Temporary Telegram code is required.');

    const apiId = Number(pending.apiId);
    const apiHash = decrypted(pending.apiHash);
    const phoneNumber = decrypted(pending.phoneNumber);
    const phoneCodeHash = decrypted(pending.phoneCodeHash);
    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 3 });
    await client.connect();
    try {
      let user;
      try {
        const result = await client.invoke(new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash,
          phoneCode: String(code).trim(),
        }));
        user = result?.user || result;
      } catch (err) {
        if (err.errorMessage === 'SESSION_PASSWORD_NEEDED' || err.message?.includes('SESSION_PASSWORD_NEEDED')) {
          if (!password) return { status: 'password_required' };
          user = await client.signInWithPassword(
            { apiId, apiHash },
            {
              password: async () => password,
              onError: async (passwordErr) => {
                throw passwordErr;
              },
            },
          );
        } else {
          throw err;
        }
      }

      const channels = await this.findAdminedPublicChannels(client);
      const preferredChannel = pickPreferredChannel(channels);
      store.sessions ??= {};
      store.sessions[userId] = {
        apiId,
        apiHash: encrypted(apiHash),
        phoneNumber: encrypted(phoneNumber),
        session: encrypted(client.session.save()),
        user: {
          id: String(user?.id ?? userId),
          username: user?.username || '',
          firstName: user?.firstName || '',
        },
        channels,
        preferredChannel,
        authorizedAt: new Date().toISOString(),
      };
      delete store.pending?.[userId];
      await this.writeStore(store);
      return {
        status: 'authorized',
        preferredChannel,
        channels,
        user: store.sessions[userId].user,
      };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  async findAdminedPublicChannels(client) {
    const result = await client.invoke(new Api.channels.GetAdminedPublicChannels({
      byLocation: false,
      checkLimit: false,
      forPersonal: false,
    }));
    return (result?.chats || [])
      .map(publicChannelInfo)
      .filter((channel) => channel.username || channel.title);
  }

  async fetchRecentChannelPosts(telegramId, channelHandle, limit = 30) {
    const sessionConfig = await this.getSessionConfig(telegramId);
    if (!sessionConfig?.session || !channelHandle) return [];
    const client = new TelegramClient(
      new StringSession(sessionConfig.session),
      Number(sessionConfig.apiId),
      sessionConfig.apiHash,
      { connectionRetries: 3 },
    );
    await client.connect();
    try {
      const messages = await client.getMessages(channelHandle, { limit: Number(limit) });
      return messages
        .map((message) => String(message?.message || '').trim())
        .filter(Boolean);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
}
