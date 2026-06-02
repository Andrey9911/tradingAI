import { AIService } from './aiService.mjs';
import { ResearchCacheService } from './researchCacheService.mjs';
import { parseResearchChannels, TelegramScraperService } from './telegramScraperService.mjs';

let researchWorkerTimer = null;

function parseKeywords(value = process.env.RESEARCH_KEYWORDS || 'token,токен,airdrop,listing,pump,dex,whale,кит,ликвидность,rug') {
  return String(value)
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function hasTokenMention(text) {
  return /\$[A-Z0-9]{2,12}\b|0x[a-f0-9]{32,}|[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text);
}

function filterResearchPosts(posts, keywords = parseKeywords()) {
  if (!keywords.length) return posts;
  return posts.filter((post) => {
    const text = String(post.text || '').toLowerCase();
    return hasTokenMention(post.text || '') || keywords.some(keyword => text.includes(keyword));
  });
}

function parseAiResearch(raw, fallbackSummary) {
  const jsonMatch = String(raw || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      summary: String(raw || fallbackSummary).slice(0, 1200),
      signals: [],
      tokens: [],
      riskNotes: [],
    };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: String(parsed.summary || fallbackSummary).slice(0, 1600),
      signals: Array.isArray(parsed.signals) ? parsed.signals.map(String).slice(0, 12) : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens.map(String).slice(0, 20) : [],
      riskNotes: Array.isArray(parsed.riskNotes) ? parsed.riskNotes.map(String).slice(0, 12) : [],
    };
  } catch {
    return {
      summary: fallbackSummary,
      signals: [],
      tokens: [],
      riskNotes: [],
    };
  }
}

export class ResearchPipelineService {
  constructor({
    scraper = new TelegramScraperService(),
    ai = new AIService(),
    cache = new ResearchCacheService(),
  } = {}) {
    this.scraper = scraper;
    this.ai = ai;
    this.cache = cache;
  }

  async executeResearchPipeline({
    channelsList = parseResearchChannels(),
    limit = Number(process.env.RESEARCH_POST_LIMIT || 10),
    onStatusUpdate = null,
  } = {}) {
    const channels = Array.isArray(channelsList) ? channelsList.filter(Boolean) : parseResearchChannels(channelsList);
    this.cache.setStatus({
      running: true,
      lastRunAt: new Date().toISOString(),
      lastError: '',
      lastChannels: channels,
    });
    try {
      if (onStatusUpdate) await onStatusUpdate(`📊 Research: читаю ${channels.length} канал(ов)…`);
      const posts = await this.scraper.fetchLatestPosts(channels, limit);
      const filteredPosts = filterResearchPosts(posts);
      if (onStatusUpdate) await onStatusUpdate(`📊 Research: найдено ${posts.length}, после фильтра ${filteredPosts.length}.`);

      const fallbackSummary = filteredPosts.length
        ? `Собрано ${filteredPosts.length} релевантных постов из ${channels.length} каналов.`
        : `Нет релевантных постов из ${channels.length} каналов.`;
      const rawAi = filteredPosts.length
        ? await this.ai.summarizeResearchPosts({ posts: filteredPosts, channels })
        : '';
      const analysis = parseAiResearch(rawAi, fallbackSummary);
      const row = this.cache.storeResearchData({
        channels,
        fetchedPosts: posts.length,
        usedPosts: filteredPosts.length,
        scraperErrors: this.scraper.lastErrors,
        ...analysis,
      });
      this.cache.setStatus({
        running: false,
        lastSuccessAt: row.createdAt,
        lastPostsFetched: posts.length,
        lastPostsUsed: filteredPosts.length,
        lastError: '',
      });
      return row;
    } catch (err) {
      this.cache.setStatus({
        running: false,
        lastError: err.message,
      });
      throw err;
    }
  }

  getStatus() {
    return this.cache.getStatus();
  }
}

export async function executeResearchPipeline(options = {}) {
  return new ResearchPipelineService().executeResearchPipeline(options);
}

export function startResearchWorker({ onStatusUpdate = null } = {}) {
  const enabled = String(process.env.RESEARCH_BACKGROUND_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) return null;
  if (researchWorkerTimer) return researchWorkerTimer;
  const intervalMinutes = Number(process.env.RESEARCH_INTERVAL_MINUTES || 30);
  const intervalMs = Math.max(1, Number.isFinite(intervalMinutes) ? intervalMinutes : 30) * 60 * 1000;
  const run = async () => {
    try {
      await executeResearchPipeline({ onStatusUpdate });
    } catch (err) {
      new ResearchCacheService().setStatus({ lastError: err.message, running: false });
    }
  };
  researchWorkerTimer = setInterval(run, intervalMs);
  run();
  return researchWorkerTimer;
}
