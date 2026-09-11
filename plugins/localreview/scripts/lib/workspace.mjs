// Copyright 2026 OpenAI
// Licensed under the Apache License, Version 2.0.
// Derived from openai/codex-plugin-cc.

import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
