---
name: telegram-autoposting
description: Approval-first Telegram MTProto autoposting flow with session.txt and channel discovery.
---

<!-- Source: derived from user-provided previous-project examples: botTelegram.mjs callbacks enterTelegram/getChannels and myBlog.json waitDataForPosting/posting workflow. Functions were not copied; only architecture patterns were extracted. -->

# Telegram Autoposting Skill

Use this skill when the SMM agent needs to publish to a public Telegram channel.

## Pattern

1. Restore GramJS `StringSession` dynamically from root `session.txt`.
2. If missing, request MTProto login through the MiniApp/chat fallback:
   - `ID_TELEGRAM`
   - `TELEGRAM_MTPROTO_API_ID` from `.env`
   - `TELEGRAM_MTPROTO_API_HASH` from `.env`
   - phone number
   - temporary code
   - optional 2FA password
3. Discover admined public channels with `channels.GetAdminedPublicChannels`.
4. Prefer `@AImodelingAgency`; fallback to `@myPublicGroupAI`.
5. Create post drafts only; publish only after explicit owner approval.

## Guardrails

- Never publish directly from background analysis.
- Never commit `session.txt`, metadata files, or trading metric data.
- Never keep a live `TelegramClient` in `ctx.session`; use `TelegramClientManager`.
- If credentials are missing, return `needs_credentials` instead of throwing.
