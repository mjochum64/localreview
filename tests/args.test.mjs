import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString } from "../plugins/localreview/scripts/lib/args.mjs";

const CONFIG = {
  valueOptions: ["base", "scope", "model", "focus", "job-id"],
  booleanOptions: ["json", "background", "wait"],
  aliasMap: { m: "model" }
};

test("parses value options, boolean flags and aliases", () => {
  const { options, positionals } = parseArgs(
    ["--base", "main", "--background", "-m", "Qwen3.8-27B-4bit", "rest"],
    CONFIG
  );
  assert.equal(options.base, "main");
  assert.equal(options.background, true);
  assert.equal(options.model, "Qwen3.8-27B-4bit");
  assert.deepEqual(positionals, ["rest"]);
});

test("parses inline values", () => {
  const { options } = parseArgs(["--scope=branch"], CONFIG);
  assert.equal(options.scope, "branch");
});

test("keeps quoted focus text together", () => {
  const tokens = splitRawArgumentString('--focus "hinterfrage das Caching-Design"');
  assert.deepEqual(tokens, ["--focus", "hinterfrage das Caching-Design"]);
});

test("throws when a value option has no value", () => {
  assert.throws(() => parseArgs(["--base"], CONFIG), /Missing value for --base/);
});
