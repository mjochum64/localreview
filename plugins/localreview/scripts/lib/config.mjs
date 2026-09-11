import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const DEFAULT_DEADLINE_MS = 1_800_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function readConfigFile(homeDir) {
  const file = path.join(homeDir, ".config", "localreview", "config.json");
  try {
    const value = readJsonFile(file);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function pick(candidates) {
  for (const [source, value] of candidates) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return { value, source };
    }
  }
  return { value: null, source: "default" };
}

function validateDeadline(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_DEADLINE_MS;
}

export function isLoopbackUrl(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl);
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export function resolveConfig(options = {}, env = process.env, homeDir = os.homedir()) {
  const file = readConfigFile(homeDir);

  const baseUrl = pick([
    ["flag", options.baseUrl],
    ["env", env.LOCALREVIEW_BASE_URL],
    ["file", file.baseUrl]
  ]);
  const model = pick([
    ["flag", options.model],
    ["env", env.LOCALREVIEW_MODEL],
    ["file", file.model]
  ]);
  const deadline = pick([
    ["flag", options.deadlineMs],
    ["env", env.LOCALREVIEW_DEADLINE_MS],
    ["file", file.deadlineMs]
  ]);

  return {
    baseUrl: baseUrl.value ?? DEFAULT_BASE_URL,
    model: model.value ?? null,
    deadlineMs: deadline.value === null ? DEFAULT_DEADLINE_MS : validateDeadline(deadline.value),
    source: {
      baseUrl: baseUrl.source,
      model: model.source
    }
  };
}
