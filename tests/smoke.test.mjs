import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("config/judge.json has a numeric threshold in (0,1]", () => {
  const cfg = JSON.parse(readFileSync(new URL("../config/judge.json", import.meta.url), "utf8"));
  assert.equal(typeof cfg.threshold, "number");
  assert.ok(cfg.threshold > 0 && cfg.threshold <= 1);
});
