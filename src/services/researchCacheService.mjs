const DEFAULT_TTL_MINUTES = Number(process.env.RESEARCH_CACHE_TTL_MINUTES || 180);
const cacheRows = [];
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
  prune() {
    const now = Date.now();
    for (let i = cacheRows.length - 1; i >= 0; i -= 1) {
      if (cacheRows[i].expiresAtMs <= now) cacheRows.splice(i, 1);
    }
  }

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
}

export function getRecentResearchData(options = {}) {
  return new ResearchCacheService().getRecentResearchData(options);
}
