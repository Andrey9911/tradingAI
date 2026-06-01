import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..', '..');
const DEFAULT_METRICS_FILE = path.join(ROOT_DIR, 'data', 'trading-metrics.json');
const DEFAULT_DRAFTS_FILE = path.join(ROOT_DIR, 'data', 'trading-post-basket.json');

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampText(value, max = 500) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function summarizeTradingMetrics(metrics) {
  const entries = metrics.slice(-10);
  const totalSpent = entries.reduce((sum, item) => sum + (toNumber(item.spentUsdt) || 0), 0);
  const totalReceived = entries.reduce((sum, item) => sum + (toNumber(item.receivedUsdt) || 0), 0);
  const realizedPnl = entries.reduce((sum, item) => sum + (toNumber(item.pnlUsd) || 0), 0);
  return {
    count: entries.length,
    totalSpent,
    totalReceived,
    realizedPnl,
    latest: entries.at(-1) || null,
    symbols: [...new Set(entries.map((item) => item.symbol).filter(Boolean))],
  };
}

export class TradingMetricsService {
  constructor({
    metricsFile = process.env.TRADING_METRICS_FILE || DEFAULT_METRICS_FILE,
    draftsFile = process.env.TRADING_POST_BASKET_FILE || DEFAULT_DRAFTS_FILE,
  } = {}) {
    this.metricsFile = path.isAbsolute(metricsFile) ? metricsFile : path.join(ROOT_DIR, metricsFile);
    this.draftsFile = path.isAbsolute(draftsFile) ? draftsFile : path.join(ROOT_DIR, draftsFile);
  }

  async readJson(filePath, fallback) {
    try {
      const text = await readFile(filePath, 'utf8');
      return safeJsonParse(text, fallback);
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  async writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
  }

  async listMetrics(limit = 50) {
    const rows = await this.readJson(this.metricsFile, []);
    return rows.slice(-limit);
  }

  async recordTrade(event) {
    const rows = await this.readJson(this.metricsFile, []);
    const metric = {
      id: createId('trade_metric'),
      createdAt: new Date().toISOString(),
      side: event.side,
      coin: event.coin,
      symbol: event.symbol || `${event.coin || ''}USDT`,
      percent: toNumber(event.percent),
      orderId: event.orderId || event.order?.orderId || null,
      spentUsdt: toNumber(event.spentUsdt),
      receivedUsdt: toNumber(event.receivedUsdt),
      quantity: toNumber(event.quantity),
      avgPrice: toNumber(event.avgPrice),
      pnlUsd: toNumber(event.pnlUsd),
      pnlPct: toNumber(event.pnlPct),
      source: event.source || 'telegram_bot',
      raw: event.raw || null,
    };
    rows.push(metric);
    await this.writeJson(this.metricsFile, rows.slice(-500));
    return metric;
  }

  async addDraft(pendingDraft, sourceMetric) {
    const drafts = await this.readJson(this.draftsFile, []);
    const row = {
      id: pendingDraft.id,
      createdAt: pendingDraft.createdAt,
      status: pendingDraft.status,
      source: 'trading_metrics',
      sourceMetricId: sourceMetric?.id || null,
      title: pendingDraft.draft.title,
      preview: clampText(pendingDraft.draft.telegramText, 700),
      pendingDraft,
    };
    drafts.push(row);
    await this.writeJson(this.draftsFile, drafts.slice(-100));
    return row;
  }

  async listDrafts({ status = 'pending_approval', limit = 10 } = {}) {
    const drafts = await this.readJson(this.draftsFile, []);
    return drafts
      .filter((draft) => !status || draft.status === status)
      .slice(-limit)
      .reverse();
  }

  async updateDraftStatus(id, status, extra = {}) {
    const drafts = await this.readJson(this.draftsFile, []);
    const next = drafts.map((draft) => (
      draft.id === id
        ? { ...draft, status, pendingDraft: { ...draft.pendingDraft, status }, ...extra }
        : draft
    ));
    await this.writeJson(this.draftsFile, next);
    return next.find((draft) => draft.id === id) || null;
  }
}
