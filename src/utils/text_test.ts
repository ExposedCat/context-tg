import { strictEqual } from "node:assert";
import { escapeSingleDollarSigns } from "./text.ts";

Deno.test("escapeSingleDollarSigns escapes ordinary dollar signs", () => {
  strictEqual(
    escapeSingleDollarSigns("It was just 13$. However, this is 3$"),
    "It was just 13\\$. However, this is 3\\$",
  );
});

Deno.test("escapeSingleDollarSigns preserves double-dollar LaTeX", () => {
  strictEqual(
    escapeSingleDollarSigns("The total is $$13 + 3 = 16$$, or $16."),
    "The total is $$13 + 3 = 16$$, or \\$16.",
  );
});

Deno.test("escapeSingleDollarSigns handles runs of dollar signs in pairs", () => {
  strictEqual(escapeSingleDollarSigns("$$$ $$$$ $$$$$"), "$$\\$ $$$$ $$$$\\$");
});

Deno.test("escapeSingleDollarSigns does not double-escape dollar signs", () => {
  strictEqual(
    escapeSingleDollarSigns("Already \\$escaped and $not."),
    "Already \\$escaped and \\$not.",
  );
});
