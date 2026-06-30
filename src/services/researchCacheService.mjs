import { createClient } from '@supabase/supabase-js';

const DEFAULT_TTL_MINUTES = Number(process.env.RESEARCH_CACHE_TTL_MINUTES || 180);
const cacheRows = [];

// === Drafts Basket (In-Memory) — корзина черновиков постов, живёт в рамках текущего процесса ===
const draftsBasket = new Map();

const status = {
  running: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: '',
  lastChannels: [],
  lastPostsFetched: 0,
  lastPostsUsed: 0,
};

function ttlMsFromEnv() {
  const minutes = Number(process.env.RESEARCH_CACHE_TTL_MINUTES || DEFAULT_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TTL_MINUTES) * 60 * 1000;
}

function nowIso() {
  return new Date().toISOString();
}

export class ResearchCacheService {
  // === Drafts Basket CRUD ===

  /** Добавляет пост-черновик в In-Memory корзину */
  addDraft(id, text) {
    const draft = { id, text, createdAt: new Date().toISOString() };
    draftsBasket.set(id, draft);
    return draft;
  }

  /** Возвращает все черновики из корзины в виде массива */
  getAllDrafts() {
    return [...draftsBasket.values()];
  }

  /** Получает один черновик по ID */
  getDraft(id) {
    return draftsBasket.get(id) || null;
  }

  /** Удаляет черновик по ID, возвращает true если удалён */
  removeDraft(id) {
    return draftsBasket.delete(id);
  }

  /** Очищает всю корзину черновиков */
  clearDrafts() {
    draftsBasket.clear();
  }

  prune() {
    const now = Date.now();
    for (let i = cacheRows.length - 1; i >= 0; i -= 1) {
      if (cacheRows[i].expiresAtMs <= now) cacheRows.splice(i, 1);
    }
  }

  //Запись в кэш
  storeResearchData(payload, { ttlMs = ttlMsFromEnv() } = {}) {
    this.prune();
    const row = {
      id: `research_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: nowIso(),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + ttlMs,
      ...payload,
    };
    cacheRows.unshift(row);
    return row;
  }

  getRecentResearchData({ hours = 3, limit = 5 } = {}) {
    this.prune();
    const minCreatedAtMs = Date.now() - hours * 60 * 60 * 1000;
    return cacheRows
      .filter(row => row.createdAtMs >= minCreatedAtMs)
      .slice(0, limit);
  }

  getStatus() {
    this.prune();
    return {
      ...status,
      cacheSize: cacheRows.length,
      freshItems: this.getRecentResearchData({ hours: 3, limit: 100 }).length,
      ttlMinutes: Math.round(ttlMsFromEnv() / 60000),
    };
  }

  setStatus(patch) {
    Object.assign(status, patch);
    return this.getStatus();
  }

  /**
   * Синхронизирует список каналов из БД.
   * @returns {Promise<Array<Object>>} Массив каналов.
   */
  async syncChannels() {
    if (!this.supabase) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
    }
    const { data, error } = await this.supabase
      .from('crypto_channels')
      .select('channel_name, channel_link');

    if (error) {
      console.error('Ошибка синхронизации каналов:', error.message);
      throw error;
    }

    this.setStatus({ lastChannels: (data || []).map(c => c.name) });
    return data || [];
  }

  async addChannel(name, url) {
    if (!this.supabase) {
      this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
    }
    const { data, error } = await this.supabase
      .from('crypto_channels')
      .insert([{ 
        channel_name: name, // маппим твою переменную name на колонку channel_name
        channel_link: url   // маппим твою переменную url на колонку channel_link
      }])
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}

export function getRecentResearchData(options = {}) {
  return new ResearchCacheService().getRecentResearchData(options);
}
