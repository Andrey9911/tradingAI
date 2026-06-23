---
name: post-style-preservation
description: Analyze previous channel posts and preserve style while generating unique trading-result drafts.
---

<!-- Source: derived from user-provided previous-project examples: myBlog.json OpenRouter content agent and manager_menu_func.mjs idea/knowledge-base n8n handoff. Functions were not copied; only method relationships were extracted. -->

# Post Style Preservation Skill

Use this skill when creating SMM drafts from code changes or trading metrics.

## Inputs

- Latest code diff or trading metric event.
- Recent public channel posts loaded through MTProto.
- Optional owner idea/context.

## Method relationships

1. Collect event context: code diff, trade result, PnL, signal summary.
2. Load recent posts from the selected channel.
3. Extract style signals:
   - language and tone;
   - paragraph length;
   - emoji density;
   - CTA patterns;
   - repeated vocabulary.
4. Generate a new draft that keeps style but does not copy phrases verbatim.
5. Put the draft into the approval basket.

## Guardrails

- Mention trading as manual-decision signals, not guaranteed profit.
- Add uniqueness notes when the draft overlaps with previous posts.
- Keep Telegram concise; keep Habr technical; keep Dzen RSS-compatible.
