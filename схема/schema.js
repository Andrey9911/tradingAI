const projectSchema = {
    nodes: [
        // Client Layer
        { id: "User", label: "👤 Пользователь", group: "client", title: "Конечный пользователь в Telegram", level: 0 },
        { id: "BotMenu", label: "📋 Главное меню", group: "client", level: 1 },
        { id: "SignalsUI", label: "📈 Сигналы UI", group: "client", level: 1 },
        { id: "OrdersUI", label: "💰 Ордера UI", group: "client", level: 1 },
        { id: "Web3UI", label: "🌐 Web3 UI", group: "client", level: 1 },
        { id: "AutoPostUI", label: "📢 Автопостинг UI", group: "client", level: 1 },
        { id: "SettingsUI", label: "⚙️ Настройки", group: "client", level: 1 },
        
        // Logic Layer - Signals
        { id: "SignalAnalysis", label: "🧠 Анализ сигналов", group: "logic", level: 2 },
        { id: "SignalStorage", label: "💾 БД сигналов", group: "logic", level: 3 },
        { id: "IndicatorSvc", label: "📊 Индикаторы", group: "logic", level: 3 },

        // Logic Layer - Trading
        { id: "BybitSvc", label: "💹 Bybit Service", group: "logic", level: 2 },
        { id: "TradingMetrics", label: "📈 Метрики торгов", group: "logic", level: 3 },

        // Logic Layer - Web3 & TON
        { id: "TonSvc", label: "💎 TON Service", group: "logic", level: 2 },
        { id: "TokenDiscovery", label: "🔍 Поиск токенов", group: "logic", level: 2 },
        { id: "WalletIntel", label: "🕵️‍♂️ Анализ кошельков", group: "logic", level: 3 },

        // Logic Layer - AI & Analytics
        { id: "AISvc", label: "🤖 AI Service", group: "logic", level: 3 },
        { id: "ResearchPipeline", label: "🔬 Research Pipeline", group: "logic", level: 3 },
        { id: "ResearchCache", label: "🗄 Кэш", group: "logic", level: 4 },

        // Logic Layer - Scrapers
        { id: "Scraper", label: "📥 TG Scraper", group: "logic", level: 2 },
        { id: "AutopostingSvc", label: "📤 Autoposting Service", group: "logic", level: 2 },
        { id: "TGClient", label: "📱 MTProto Client", group: "logic", level: 3 },
        
        { id: "AuthSvc", label: "🔑 Auth Service", group: "logic", level: 2 },

        // External Layer
        { id: "DB", label: "🗄 Supabase DB", group: "external", level: 5 },
        { id: "TG_API", label: "🚀 Telegram API", group: "external", level: 5 },
        { id: "Bybit_API", label: "📈 Bybit API", group: "external", level: 5 },
        { id: "TON_Node", label: "💎 TON Blockchain", group: "external", level: 5 },
        { id: "LLM", label: "🧠 LLM (OpenAI)", group: "external", level: 5 }
    ],
    edges: [
        // UI to Logic
        { from: "User", to: "BotMenu", label: "Команды" },
        { from: "User", to: "OrdersUI", label: "Торги" },
        { from: "User", to: "Web3UI", label: "Web3" },
        { from: "User", to: "SignalsUI", label: "Сигналы" },
        { from: "User", to: "AutoPostUI" },
        { from: "BotMenu", to: "AuthSvc" },
        { from: "SignalsUI", to: "SignalAnalysis" },
        { from: "OrdersUI", to: "BybitSvc" },
        { from: "Web3UI", to: "TonSvc" },
        { from: "Web3UI", to: "TokenDiscovery" },
        { from: "AutoPostUI", to: "AutopostingSvc" },

        // Logic to Logic
        { from: "SignalAnalysis", to: "IndicatorSvc" },
        { from: "SignalAnalysis", to: "AISvc" },
        { from: "SignalAnalysis", to: "SignalStorage" },
        { from: "Scraper", to: "ResearchPipeline" },
        { from: "ResearchPipeline", to: "AISvc" },
        { from: "ResearchPipeline", to: "ResearchCache" },
        { from: "AutopostingSvc", to: "AISvc" },
        { from: "TokenDiscovery", to: "WalletIntel" },
        { from: "WalletIntel", to: "TonSvc" },
        { from: "WalletIntel", to: "AISvc" },
        { from: "TradingMetrics", to: "BybitSvc" },
        { from: "Scraper", to: "TGClient" },

        // Logic to External
        { from: "AuthSvc", to: "DB" },
        { from: "SignalStorage", to: "DB" },
        { from: "ResearchCache", to: "DB" },
        { from: "SettingsUI", to: "DB" },
        { from: "BybitSvc", to: "Bybit_API", dashes: true },
        { from: "TonSvc", to: "TON_Node", dashes: true },
        { from: "WalletIntel", to: "TON_Node", dashes: true },
        { from: "AISvc", to: "LLM", dashes: true },
        { from: "TGClient", to: "TG_API", dashes: true },
        { from: "AutopostingSvc", to: "TG_API", dashes: true }
    ]
};
