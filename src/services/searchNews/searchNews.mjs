import { SentimentIntensityAnalyzer } from 'vader-sentiment';
import { fetchNewsArticles } from './server.mjs';

const analyzer = SentimentIntensityAnalyzer;
const SECTORS = [
  { name: 'bitcoin', terms: ['bitcoin', 'btc', 'etf'] },
  { name: 'crypto regulation', terms: ['crypto regulation', 'cryptocurrency regulation', 'crypto law', 'digital asset law'] },
  { name: 'SEC', terms: ['sec', 'securities and exchange commission', 'gary gensler'] },
  { name: 'oil', terms: ['oil', 'crude'] }, { name: 'Brent', terms: ['brent'] },
  { name: 'OPEC', terms: ['opec', 'opec+'] }, { name: 'Iran oil', terms: ['iran', 'strait of hormuz', 'iranian oil'] },
  { name: 'Trump tariffs', terms: ['trump tariff', 'tariff', 'trade war'] }, { name: 'MiCA', terms: ['mica', 'markets in crypto-assets'] },
  { name: 'stablecoin', terms: ['stablecoin', 'usdt', 'usdc', 'tether', 'circle'] },
  { name: 'interest rates', terms: ['interest rate', 'fed rate', 'rate cut', 'rate hike', 'fomc'] },
  { name: 'inflation', terms: ['inflation', 'cpi', 'pce', 'consumer prices'] },
];
const CRITICAL = ['war', 'attack', 'sanction', 'ban', 'emergency', 'lawsuit', 'indict', 'default', 'hack', 'exploit', 'collapse', 'rate decision', 'fomc decision', 'sec approval', 'sec reject'];
const IMPORTANT = ['sec', 'regulation', 'etf', 'opec', 'iran', 'tariff', 'mica', 'stablecoin', 'interest rate', 'inflation', 'cpi', 'fed'];
const ENTITIES = ['Bitcoin', 'SEC', 'Federal Reserve', 'OPEC', 'Iran', 'Donald Trump', 'MiCA', 'Tether', 'Circle', 'USDT', 'USDC', 'Brent'];
function clean(text = '') { return String(text).replace(/\s+/g, ' ').trim(); }
function normalizedTitle(title) { return clean(title).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter((word) => word.length > 2); }
function textOf(article) { return `${article.title || ''} ${article.description || ''}`.toLowerCase(); }
function classify(article) { const text = textOf(article); return SECTORS.filter((sector) => sector.terms.some((term) => text.includes(term))).map((sector) => sector.name); }
function extractEntities(article, topic) {
  const text = `${article.title || ''} ${article.description || ''}`; const lower = text.toLowerCase();
  const named = ENTITIES.filter((entity) => lower.includes(entity.toLowerCase()));
  const tickers = [...text.matchAll(/(?:\$|\b)([A-Z]{2,10})\b/g)].map((match) => match[1]).filter((ticker) => !['USD', 'THE', 'AND', 'FOR', 'WITH'].includes(ticker));
  for (const entity of article.entities || []) if (entity.name) named.push(entity.name);
  if (topic) named.push(String(topic).toUpperCase());
  return [...new Set([...named, ...tickers])].slice(0, 15);
}
function sentiment(article) { const score = analyzer.polarity_scores(`${article.title || ''}. ${article.description || ''}`).compound; return { score: Number(score.toFixed(3)), label: score >= 0.15 ? 'positive' : score <= -0.15 ? 'negative' : 'neutral' }; }
function ageHours(value) { const timestamp = Date.parse(value || ''); return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 3_600_000) : 48; }
function importance(article) {
  const text = textOf(article); const criticalHits = CRITICAL.filter((term) => text.includes(term)).length; const importantHits = IMPORTANT.filter((term) => text.includes(term)).length;
  const sectorHits = classify(article).length; const recency = Math.max(0, 20 - Math.min(20, ageHours(article.publishedAt)));
  const score = Math.min(100, 20 + criticalHits * 30 + importantHits * 12 + sectorHits * 8 + recency + (article.source === 'marketaux' ? 4 : 0));
  const priority = score >= 75 || criticalHits >= 2 ? 'Критически важные' : score >= 52 ? 'Важные' : score >= 32 ? 'Заслуживают внимания' : 'Фоновый контекст';
  return { score: Math.round(score), priority };
}
function titleSimilarity(a, b) { const left = new Set(normalizedTitle(a)); const right = new Set(normalizedTitle(b)); if (!left.size || !right.size) return 0; let common = 0; for (const word of left) if (right.has(word)) common += 1; return common / Math.min(left.size, right.size); }
function groupArticles(articles, topic) {
  const groups = [];
  for (const article of articles.filter((item) => item.title && item.url)) {
    const existing = groups.find((group) => group.articles.some((item) => item.url === article.url || titleSimilarity(item.title, article.title) >= 0.72));
    if (existing) existing.articles.push(article); else groups.push({ articles: [article] });
  }
  return groups.map((group) => {
    const primary = group.articles.sort((a, b) => importance(b).score - importance(a).score)[0];
    const details = importance(primary); const mood = sentiment(primary);
    return { title: clean(primary.title), summary: clean(primary.description).slice(0, 500), url: primary.url, publishedAt: primary.publishedAt, sources: [...new Set(group.articles.map((item) => item.sourceName))], articleCount: group.articles.length, categories: [...new Set(group.articles.flatMap(classify))], entities: [...new Set(group.articles.flatMap((item) => extractEntities(item, topic)))], sentiment: mood, importance: details.score, priority: details.priority };
  }).sort((a, b) => b.importance - a.importance || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
}

/** Returns newest important news sorted by importance, ready for AI prompt consumption. */
export async function getNewsSentiment(coinSymbol) {
  const topic = clean(coinSymbol).toUpperCase();
  const { articles, cache, sourceErrors } = await fetchNewsArticles(topic);
  const importantNews = groupArticles(articles, topic).slice(0, 12);
  const weighted = importantNews.reduce((sum, item) => sum + item.sentiment.score * Math.max(item.importance, 1), 0);
  const weight = importantNews.reduce((sum, item) => sum + Math.max(item.importance, 1), 0);
  const score = weight ? Number((weighted / weight).toFixed(3)) : 0;
  return { topic, overall: score >= 0.12 ? 'bullish' : score <= -0.12 ? 'bearish' : 'neutral', sentimentScore: score, 'important-news': importantNews, generatedAt: new Date().toISOString(), cache, sourceErrors };
}
