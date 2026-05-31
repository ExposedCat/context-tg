const API_URL = "https://stooq.com";

export async function fetchTickerPrice(ticker: string): Promise<number | null> {
  try {
    const response = await fetch(
      `${API_URL}/q/l/?s=${encodeURIComponent(ticker.trim())}`,
    );
    const data = await response.text();
    const price = Number(data.split(",").at(6));
    return Number.isFinite(price) ? price : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}
