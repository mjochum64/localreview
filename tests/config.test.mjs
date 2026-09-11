import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers.mjs";
import {
  DEFAULT_BASE_URL,
  DEFAULT_DEADLINE_MS,
  isLoopbackUrl,
  resolveConfig
} from "../plugins/localreview/scripts/lib/config.mjs";

function writeConfigFile(homeDir, value) {
  const dir = path.join(homeDir, ".config", "localreview");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(value), "utf8");
}

test("falls back to the loopback default", () => {
  const home = makeTempDir();
  const config = resolveConfig({}, {}, home);
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.model, null);
  assert.equal(config.deadlineMs, DEFAULT_DEADLINE_MS);
  assert.equal(config.source.baseUrl, "default");
});

test("config file beats the default", () => {
  const home = makeTempDir();
  writeConfigFile(home, { baseUrl: "http://127.0.0.1:1234/v1", model: "file-model" });
  const config = resolveConfig({}, {}, home);
  assert.equal(config.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(config.model, "file-model");
  assert.equal(config.source.model, "file");
});

test("env beats the config file and flags beat env", () => {
  const home = makeTempDir();
  writeConfigFile(home, { baseUrl: "http://127.0.0.1:1234/v1", model: "file-model" });
  const env = { LOCALREVIEW_BASE_URL: "http://127.0.0.1:9000/v1", LOCALREVIEW_MODEL: "env-model" };
  const fromEnv = resolveConfig({}, env, home);
  assert.equal(fromEnv.baseUrl, "http://127.0.0.1:9000/v1");
  assert.equal(fromEnv.source.baseUrl, "env");

  const fromFlag = resolveConfig({ model: "flag-model" }, env, home);
  assert.equal(fromFlag.model, "flag-model");
  assert.equal(fromFlag.source.model, "flag");
});

test("a broken config file does not crash resolution", () => {
  const home = makeTempDir();
  const dir = path.join(home, ".config", "localreview");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), "{ not json", "utf8");
  const config = resolveConfig({}, {}, home);
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
});

test("detects non-loopback targets", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8000/v1"), true);
  assert.equal(isLoopbackUrl("http://localhost:8000/v1"), true);
  assert.equal(isLoopbackUrl("http://[::1]:8000/v1"), true);
  assert.equal(isLoopbackUrl("https://api.example.com/v1"), false);
});

test("validates deadline values and falls back to default for invalid inputs", () => {
  const home = makeTempDir();

  // Non-numeric env value falls back to default
  const nonNumeric = resolveConfig({}, { LOCALREVIEW_DEADLINE_MS: "abc" }, home);
  assert.equal(nonNumeric.deadlineMs, DEFAULT_DEADLINE_MS);

  // Non-positive value falls back to default
  const zero = resolveConfig({}, { LOCALREVIEW_DEADLINE_MS: "0" }, home);
  assert.equal(zero.deadlineMs, DEFAULT_DEADLINE_MS);

  const negative = resolveConfig({}, { LOCALREVIEW_DEADLINE_MS: "-5" }, home);
  assert.equal(negative.deadlineMs, DEFAULT_DEADLINE_MS);

  // Valid numeric string resolves to the number
  const valid = resolveConfig({}, { LOCALREVIEW_DEADLINE_MS: "60000" }, home);
  assert.equal(valid.deadlineMs, 60000);
  assert.equal(typeof valid.deadlineMs, "number");
});
