import { fetchTickerPrice } from "../stocks.ts";
import type { FunctionToolRunner } from "./types.ts";
import { getString } from "./utils.ts";

export const toolDefinition = {
  type: "function",
  name: "fetch_ticker_price",
  description:
    "Fetch the latest available price details for a Stooq ticker, including open, high, low, close, and volume. For example AAPL.US or VUAA.UK.",
  parameters: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "Stooq ticker symbol, for example AAPL.US or VUAA.UK.",
      },
    },
    required: ["ticker"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const execute: FunctionToolRunner = async (args) => {
  const ticker = getString(args?.ticker);
  const priceDetails = ticker ? await fetchTickerPrice(ticker) : null;

  return JSON.stringify({ ticker, priceDetails });
};
