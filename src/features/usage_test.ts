import { strictEqual } from "node:assert";
import { parseGuestUsageCommand } from "./usage.ts";

Deno.test("guest usage commands are parsed after the bot mention", () => {
  strictEqual(parseGuestUsageCommand("@LayloBot /usage", "LayloBot"), "");
  strictEqual(
    parseGuestUsageCommand("  @laylobot   /usage tools 42  ", "LayloBot"),
    "tools 42",
  );
  strictEqual(
    parseGuestUsageCommand(
      "@LayloBot /usage@LayloBot image_responses 3",
      "LayloBot",
    ),
    "image_responses 3",
  );
});

Deno.test("guest usage commands must target the current bot exactly", () => {
  strictEqual(parseGuestUsageCommand("/usage tools 42", "LayloBot"), undefined);
  strictEqual(
    parseGuestUsageCommand("@OtherBot /usage tools 42", "LayloBot"),
    undefined,
  );
  strictEqual(
    parseGuestUsageCommand("@LayloBot /usage_report", "LayloBot"),
    undefined,
  );
});
