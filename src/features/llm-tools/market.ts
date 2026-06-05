import { getMarketsState } from "../stocks.ts";
import type { FunctionToolRunner } from "./types.ts";

export const toolDefinition = {
  type: "function",
  name: "get_markets_state",
  description:
    "Get precomputed UK and US market session state. Returns current Europe/Prague and Europe/Kyiv times, each exchange's current state, next state, time until next state, next-state time in Prague/Kyiv, and the full regular weekday schedule localized to both Prague and Kyiv.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const execute: FunctionToolRunner = () =>
  JSON.stringify(getMarketsState());
