import { test } from "bun:test";
import { ok } from "node:assert";
import { guestAgent } from "./guest.ts";

test("guest agent can generate images", () => {
  ok(guestAgent.tools.includes("generate_image"));
});
