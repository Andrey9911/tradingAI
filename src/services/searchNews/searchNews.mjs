
export async function getNewsSentiment(coinSymbol) {
  try {
    const response = await fetch(`http://localhost:3001/analyze?topic=${coinSymbol}`);
    if (!response.ok) return null;
    const data = await response.json();
    return {
      overall: data.overall,
      positive: data.positive,
      negative: data.negative,
      neutral: data.neutral,
    };
  } catch (err) {
    console.error(`Ошибка новостного сервера для ${coinSymbol}:`, err.message);
    return null;
  }
}