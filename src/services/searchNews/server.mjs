import express from 'express';
import cors from 'cors';
import { SentimentIntensityAnalyzer } from 'vader-sentiment';
import fetch from 'node-fetch';

// --- Конфигурация ---
const CRYPTOPANIC_API_KEY = "YOUR_API_KEY_HERE"; // Замените на ваш ключ
const PORT = process.env.PORT || 3001;
// ------------------

const app = express();
app.use(cors()); // Разрешаем запросы с любых источников

// Инициализируем VADER анализатор
const vader = new SentimentIntensityAnalyzer();

// Функция для анализа заголовка с помощью VADER
function analyzeSentiment(text) {
    const result = vader.polarity_scores(text);
    const compound = result.compound;
    
    if (compound >= 0.05) return 'positive';
    if (compound <= -0.05) return 'negative';
    return 'neutral';
}

// --- Эндпоинт ---
app.get('/analyze', async (req, res) => {
    const topic = req.query.topic;
    
    if (!topic) {
        return res.status(400).json({ error: 'Missing topic parameter' });
    }
    
    if (!CRYPTOPANIC_API_KEY || CRYPTOPANIC_API_KEY === "YOUR_API_KEY_HERE") {
        // Возвращаем заглушку, если ключ не настроен
        return res.json({
            topic: topic.toUpperCase(),
            positive: 0,
            negative: 0,
            neutral: 0,
            overall: 'neutral',
            total: 0
        });
    }
    
    try {
        // Параметры запроса к CryptoPanic API
        const params = new URLSearchParams({
            auth_token: CRYPTOPANIC_API_KEY,
            currencies: topic.toUpperCase(),
            kind: 'news',
            public: 'true',
            filter: 'hot' // 'rising', 'hot' или 'all'
        });
        
        const response = await fetch(`https://cryptopanic.com/api/v1/posts/?${params}`);
        
        if (!response.ok) {
            throw new Error(`CryptoPanic API error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        const articles = data.results || [];
        
        let positive = 0, negative = 0, neutral = 0;
        
        for (const item of articles) {
            const title = item.title;
            if (!title) continue;
            
            const sentiment = analyzeSentiment(title);
            if (sentiment === 'positive') positive++;
            else if (sentiment === 'negative') negative++;
            else neutral++;
        }
        
        const total = positive + negative + neutral;
        let overall = 'neutral';
        
        if (total > 0) {
            if (positive > negative + (total * 0.2)) {
                overall = 'bullish';
            } else if (negative > positive + (total * 0.2)) {
                overall = 'bearish';
            } else {
                overall = 'neutral';
            }
        }
        
        res.json({
            topic: topic.toUpperCase(),
            positive,
            negative,
            neutral,
            overall,
            total
        });
        
    } catch (error) {
        console.error('Error analyzing news:', error);
        res.status(500).json({ error: 'Failed to fetch or analyze news' });
    }
});

// --- Запуск сервера ---
app.listen(PORT, () => {
    console.log(`🔍 Crypto News Sentiment Server running on http://localhost:${PORT}`);
    console.log(`📍 Example: http://localhost:${PORT}/analyze?topic=SOL`);
});