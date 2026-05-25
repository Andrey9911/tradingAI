import { z } from 'zod';

export const parsedEntrySchema = z.object({
  type: z.enum(['RANGE', 'LEVELS', 'SINGLE']),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  levels: z.array(z.number()).default([]),
});

export const parsedSignalSchema = z.object({
  symbol: z.string().min(3),
  side: z.enum(['BUY', 'SELL']),
  marketType: z.enum(['SPOT', 'FUTURES']),
  entry: parsedEntrySchema,
  takeProfits: z.array(z.number()),
  stopLoss: z.number().nullable(),
  leverage: z.number().nullable().optional(),
  timeframe: z.string().nullable().optional(),
  rawConfidence: z.string().nullable().optional(),
  warnings: z.array(z.string()).default([]),
});

/** Снимок рынка для БД / форматтера */
export const marketSnapshotSchema = z.object({
  currentPrice: z.number(),
  change24h: z.number(),
  volume24h: z.number(),
  turnover24h: z.number(),
  rsi1h: z.number().nullable(),
  ema20_1h: z.number().nullable(),
  ema50_1h: z.number().nullable(),
  atr14_1h: z.number().nullable(),
  volumeSpike: z.number().nullable(),
  spreadPct: z.number().nullable(),
  oiChange1h: z.number().nullable(),
  oiChange4h: z.number().nullable(),
  oiChange24h: z.number().nullable(),
  fundingRate: z.number().nullable(),
  longShortRatio: z.number().nullable(),
  momentum1hPct: z.number().nullable(),
  rawJson: z.any().optional(),
});

export const analysisResultSchema = z.object({
  parsed: parsedSignalSchema,
  symbolNormalized: z.string(),
  instrumentValid: z.boolean(),
  sourceTitle: z.string().nullable(),
  sourceType: z.enum(['forward', 'paste']),
  currentPrice: z.number(),
  entryStatus: z.enum(['BELOW_ENTRY', 'IN_ENTRY', 'ABOVE_ENTRY']),
  entryLatePct: z.number().nullable(),
  rr: z.object({
    tp1: z.number().nullable(),
    tp2: z.number().nullable(),
    tp3: z.number().nullable(),
  }),
  score: z.number(),
  verdict: z.enum(['BUY', 'WAIT', 'AVOID']),
  risk: z.enum(['Low', 'Medium', 'Medium-High', 'High']),
  aiReason: z.string(),
  aiAdvice: z.string(),
  snapshot: marketSnapshotSchema,
  spotOrderAllowed: z.boolean(),
  userWarnings: z.array(z.string()),
});
