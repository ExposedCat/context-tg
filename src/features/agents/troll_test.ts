import { ok, strictEqual } from "node:assert";
import type { Database } from "../database.ts";
import {
  getTrollingModeInstructions,
  TROLLING_MODES,
} from "../trolling-mode.ts";
import { buildInstructions } from "./troll.ts";

Deno.test("troll prompt receives one selected style without a catalogue of modes", async () => {
  const base = buildInstructions(123);
  ok(
    !/\b(aggressive|mild|clean)\b/.test(base),
    "Shared prompt must not describe selectable modes",
  );
  for (const mode of TROLLING_MODES) {
    const database = {
      selectFrom() {
        return {
          select() {
            return this;
          },
          where() {
            return this;
          },
          executeTakeFirst() {
            return Promise.resolve({ trolling_mode: mode });
          },
        };
      },
    } as unknown as Database;
    const prompt = `${base}\n${await getTrollingModeInstructions(
      database,
      123,
    )}`;
    strictEqual((prompt.match(/<trolling_mode>/g) ?? []).length, 1);
    ok(prompt.includes(`This chat's trolling mode is ${mode}.`));
    ok(!/\b(aggressive|mild|clean)\s+(uses|permits)/.test(prompt));
  }
});
