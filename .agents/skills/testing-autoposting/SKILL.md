---
name: testing-autoposting
description: Test the tradingAI approval-first autoposting flow. Use when verifying SMM autopost draft, approval, Telegram MTProto, Habr draft, or Dzen RSS changes.
---

# Testing approval-first autoposting

## Devin Secrets Needed

For full live E2E testing, request these secrets before starting:

- `API_KEY`: Telegram Bot API token from BotFather, used to run the grammY bot UI.
- `OWNER_ID`: Telegram user id allowed by the owner-only middleware.
- `OPENROUTER_API_KEY`: enables real AI draft generation through `AIService`.
- `TELEGRAM_MTPROTO_API_ID`: MTProto app id from https://my.telegram.org/apps.
- `TELEGRAM_MTPROTO_API_HASH`: MTProto app hash from https://my.telegram.org/apps.
- `TELEGRAM_MTPROTO_SESSION`: GramJS `StringSession` for the posting account.
- `TELEGRAM_AUTOPOST_CHANNEL`: private test channel username/id for publish verification.

If live secrets are unavailable and the user chooses to skip them, run safe shell-only testing instead and explicitly mark live Telegram UI, OpenRouter, and real MTProto publish as untested.

## Shell checks

Run from the repo root:

```bash
npm run check
```

This should syntax-check `src/composers/autoposting.mjs` and `src/services/autopostingService.mjs`.

## Safe no-secret smoke flow

Use a temporary Node script that imports:

- `AutopostingService`
- `formatDraftForTelegram`
- `getAutopostingEnvTemplate`
- `showAutopostingMenu`

Mock `ai.createAutopostingDraft()` to return deterministic JSON. Configure Telegram MTProto fields as empty strings and Dzen output to a temporary artifact path.

Verify:

1. `createDraft(...)` returns `status: "pending_approval"` and includes the mocked title/body fields.
2. `publishApproved(pendingDraft)` before approval throws exactly `Autoposting draft must be approved before publishing.`
3. `approveDraft(pendingDraft, 4242)` returns `status: "approved"` and `approval.approvedBy === "4242"`.
4. Post-approval publish returns:
   - Telegram: `status: "needs_credentials"` and reason mentions `TELEGRAM_MTPROTO_API_ID`.
   - Habr: `status: "draft_only"` with markdown content.
   - Dzen: `status: "rss_exported"`, and the RSS file exists with the mocked title/body.
5. `getAutopostingEnvTemplate()` includes all MTProto keys.
6. `showAutopostingMenu(fakeCtx)` replies with `Autoposting Center`, `Pending draft: нет`, `Past post samples: 0`, and callback data for `autoposting_generate`, `autoposting_add_samples`, and `autoposting_env`.

Clean up temporary scripts and RSS artifacts before finishing.

## Live UI flow when secrets are available

Run the bot with the test secrets, open Telegram as `OWNER_ID`, send `/start`, click `📣 Автопостинг`, add 1-5 past-post samples, generate a draft, review it, then approve to a private test channel only. The expected real publish result should include a Telegram message id; do not test against a public channel first.
