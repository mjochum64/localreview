import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export function makeTempDir(prefix = "localreview-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    windowsHide: true
  });
}

// spawnSync blocks this process's entire event loop until the child exits. That is
// fine for plain commands, but it deadlocks a test that also hosts an in-process
// fake HTTP server the child needs to call back into: the server's request handler
// never runs because the event loop is stuck waiting for the child. Use this async
// variant whenever the child talks to a server started in this same process.
export function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: null, signal: null, stdout, stderr, error });
    });
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr, error: null });
    });
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "localreview Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
}
