---
name: testing-tradingai-cli
description: Test TradingAI CLI-only modules and agent orchestrator flows. Use when verifying Node.js smoke commands, copied Python skills, or guardrail JSON without browser/Telegram interaction.
---

# TradingAI CLI Testing

Use this skill when a change is exercised through shell commands rather than a browser or Telegram UI.

## Devin Secrets Needed

- None for `agents_orchestrator.mjs` smoke testing.
- Telegram/OpenRouter/Bybit/Supabase runtime flows may require repo/environment secrets such as `API_KEY`, `OWNER_ID`, `OPENROUTER_API_KEY`, `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` depending on the feature under test.

## Verified commands

From the repo root:

```bash
node agents_orchestrator.mjs
npm run check
python -m compileall -q skills_agents
```

For orchestrator smoke output, assert exact JSON values rather than only checking exit code:

- `status` is `"ok"`
- `autoposting` is `false`
- agent ids are `engineer`, `copywriter`, `smm`
- copied skill ids include blockchain/API, math, and social skills
- representative smoke metrics are present

Also verify `context_agents/project_state.json` guardrails when agent/orchestrator work changes:

- `autoTrading` is `false`
- `autoPosting` is `false`
- `manualActionOnly` is `true`

## Notes

- Do not record the desktop when all testing is shell-only; capture command output as evidence instead.
- A nested Node assertion harness might be unreliable in some Windows-hosted shells if `process.execPath` points to a missing hostedtoolcache path. Prefer running the product command directly and parsing stdout with Python stdlib JSON for assertions.
- `python -m compileall -q skills_agents` may create `__pycache__` directories. Treat those as temporary test artifacts and do not commit them.
