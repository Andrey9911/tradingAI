import { TelegramClientManager } from './TelegramClientManager.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseResearchChannels(value = process.env.RESEARCH_TELEGRAM_CHANNELS || '') {
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function messageText(message) {
  return String(message?.message || message?.text || '').trim();
}

function messageDateIso(message) {
  const date = Number(message?.date);
  if (!Number.isFinite(date) || date <= 0) return null;
  return new Date(date * 1000).toISOString();
}

export class TelegramScraperService {
  constructor({
    channels = parseResearchChannels(),
    perChannelDelayMs = Number(process.env.TELEGRAM_SCRAPER_CHANNEL_DELAY_MS || 800),
  } = {}) {
    this.channels = channels;
    this.perChannelDelayMs = Number.isFinite(perChannelDelayMs) && perChannelDelayMs >= 0 ? perChannelDelayMs : 800;
    this.lastErrors = [];
  }

  async fetchLatestPosts(channelsList = this.channels, limit = 10) {
    console.log('читаю каждый');
    const channels = Array.isArray(channelsList) ? channelsList.filter(Boolean) : parseResearchChannels(channelsList);
    if (!channels.length) return [];
    console.log("каналы есть");
    
    const posts = [];
    const errors = [];
    await TelegramClientManager.runAction(async (client) => {
      console.log('client', client);
      console.log('limit', limit);
      console.log('channels', channels);
      for (const channel of channels) {
        try {
          console.log('channel', channel);
          const messages = await client.getMessages(channel, { limit: Number(limit) || 10 });
          messages
            .map(message => ({
              channel,
              id: message?.id ?? null,
              date: messageDateIso(message),
              text: messageText(message),
              views: Number.isFinite(Number(message?.views)) ? Number(message.views) : null,
              forwards: Number.isFinite(Number(message?.forwards)) ? Number(message.forwards) : null,
            }))
            .filter(post => post.text)
            .forEach(post => posts.push(post));
        } catch (err) {
          errors.push({ channel, message: err.message });
        }
        if (this.perChannelDelayMs > 0) await sleep(this.perChannelDelayMs);
      }
    });
    this.lastErrors = errors;
    return posts;
  }
}
