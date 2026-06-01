---
name: telegram-autoposting
description: Approval-first Telegram MTProto autoposting flow with encrypted sessions and channel discovery.
---

<!-- Source: derived from user-provided previous-project examples: botTelegram.mjs callbacks enterTelegram/getChannels and myBlog.json waitDataForPosting/posting workflow. Functions were not copied; only architecture patterns were extracted. -->

# Telegram Autoposting Skill

Use this skill when the SMM agent needs to publish to a public Telegram channel.

## Pattern

1. Restore encrypted GramJS `StringSession` from `data/telegram-mtproto-session.enc.json`.
2. If missing, request MTProto login through the MiniApp/chat fallback:
   - `ID_TELEGRAM`
   - `API_ID`
   - `API_HASH`
   - phone number
   - temporary code
   - optional 2FA password
3. Discover admined public channels with `channels.GetAdminedPublicChannels`.
4. Prefer `@AImodelingAgency`; fallback to `@myPublicGroupAI`.
5. Create post drafts only; publish only after explicit owner approval.

## Guardrails

- Never publish directly from background analysis.
- Never commit encrypted session files or trading metric data.
- If credentials are missing, return `needs_credentials` instead of throwing.
