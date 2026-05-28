🤖 Bybit AI Combine & Trading Assistant
A powerful Telegram bot designed to manage your Bybit spot portfolio with precision. It doesn't just track prices—it calculates your actual performance (Net ROI) and leverages a smart AI fallback system to find high-probability trade setups.

🔥 Key Features
Real PnL (30d) Tracking: Calculates your actual profit/loss by aggregating all buy and sell orders over the last 30 days. It accounts for partial profit-taking to give you a true Net ROI.

Smart AI Fallback System: The bot is built to handle API rate limits. It uses a pool of free AI models (Llama 3, Gemma, Qwen, etc.) and automatically switches to the next available model if the current one is busy or fails.

AI-Powered Analysis: Integrated with OpenRouter (LLM) to analyze market metrics like RSI, Funding Rates, Open Interest (OI), and Volume Spikes for a professional "BUY/WAIT/AVOID" verdict.

One-Click Execution: Execute market orders directly from Telegram buttons (25%, 50%, or 100% of your position or balance).

Precise "Shitcoin" Handling: Optimized for low-satoshi tokens with high decimal precision (up to 10 places) to avoid display bugs.

🛠 Tech Stack
Runtime: Node.js (ESM)

Framework: grammY

API: bybit-api (V5 Rest Client)

Autoposting: GramJS/MTProto for Telegram after owner approval; Habr draft export because the public Habr API is internal-only; Dzen RSS export for Studio ingestion.

Database: Supabase (PostgreSQL)

AI Engine: OpenRouter API

⚙️ AI Configuration
You can manage the AI models in your .env file. The bot will try them in the order they are listed:

Bash
# Example model priority list
OPENROUTER_FREE_MODELS="google/gemma-2-9b-it:free,meta-llama/llama-3.2-3b-instruct:free,qwen/qwen3-next-80b-a3b-instruct:free"
🚀 Quick Start
1. Clone the Repository
Bash
git clone https://github.com/your-username/bybit-ai-combine.git
cd bybit-ai-combine
2. Install Dependencies
Bash
npm install
3. Environment Setup
Create a .env file in the root directory based on the provided example:

Bash
cp .env.example .env
Fill in your credentials (API keys for Bybit, OpenRouter, and Supabase).

Autoposting placeholders:

```bash
AUTOPOSTING_ENABLED=false
AUTOPOSTING_PLATFORMS=telegram,habr,dzen
TELEGRAM_MTPROTO_API_ID=<my.telegram.org api_id>
TELEGRAM_MTPROTO_API_HASH=<my.telegram.org api_hash>
TELEGRAM_MTPROTO_SESSION=<GramJS StringSession>
TELEGRAM_AUTOPOST_CHANNEL=@your_channel
AUTOPOSTING_TELEGRAM_ENABLED=true
AUTOPOSTING_HABR_ENABLED=true
HABR_PROFILE_URL=https://habr.com/ru/users/<username>/
AUTOPOSTING_DZEN_ENABLED=true
DZEN_RSS_TITLE="Trading AI autopost drafts"
DZEN_RSS_FEED_URL=https://example.com/dzen.xml
DZEN_SITE_URL=https://example.com
DZEN_RSS_OUTPUT_PATH=data/autoposting-dzen.xml
```

Autoposting is approval-first: the SMM agent can draft from code changes and past-post style samples, but publishing requires the owner to approve the pending draft in Telegram.

4. Run the Bot
Bash
npm start
📂 Project Structure
main.mjs — Entry point and bot initialization.

/services/aiService.mjs — The heart of AI logic: contains the fallback mechanism and model rotation.

/composers — Modular logic for Assets, Orders, and Signals.

/utils — Helper functions for encryption and formatting.

⚠️ Security
All user API keys are encrypted using AES-256-CBC before being stored. Never commit your .env file to a public repository!
