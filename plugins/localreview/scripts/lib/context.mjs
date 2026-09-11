import fs from "node:fs";
import path from "node:path";

import { isSecretPath } from "./secrets.mjs";

export { SECRET_FILE_PATTERNS, isSecretPath } from "./secrets.mjs";

export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

function defaultReadFile(repoRoot) {
  return (relativePath) => {
    try {
      return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    } catch {
      return null;
    }
  };
}

export function buildReviewPayload(reviewContext, options = {}) {
  const budgetTokens = options.budgetTokens ?? 8_000;
  const readFile = options.readFile ?? defaultReadFile(reviewContext.repoRoot);

  const header = [
    `Branch: ${reviewContext.branch}`,
    `Review-Ziel: ${reviewContext.target.label}`,
    reviewContext.summary,
    ""
  ].join("\n");

  const core = `${header}${reviewContext.content}`;
  let used = estimateTokens(core);
  const overBudget = used > budgetTokens;

  const includedFiles = [];
  const omittedFiles = [];
  const secretFiles = [];
  const bodies = [];

  for (const file of reviewContext.changedFiles) {
    if (isSecretPath(file)) {
      secretFiles.push(file);
      continue;
    }
    if (overBudget) {
      omittedFiles.push(file);
      continue;
    }
    const content = readFile(file);
    if (content === null) {
      omittedFiles.push(file);
      continue;
    }
    const block = `\n## Datei: ${file}\n\n\`\`\`\n${content}\n\`\`\`\n`;
    const cost = estimateTokens(block);
    if (used + cost > budgetTokens) {
      omittedFiles.push(file);
      continue;
    }
    used += cost;
    includedFiles.push(file);
    bodies.push(block);
  }

  const notes = [];
  if (omittedFiles.length > 0) {
    notes.push(`\n## Aus Platzgruenden ausgelassen\n\n${omittedFiles.join("\n")}\n`);
  }
  if (secretFiles.length > 0) {
    notes.push(
      `\n## Aus Sicherheitsgruenden ausgelassen (moegliche Zugangsdaten)\n\n${secretFiles.join("\n")}\n`
    );
  }

  return {
    text: [core, ...bodies, ...notes].join(""),
    includedFiles,
    omittedFiles,
    secretFiles,
    overBudget
  };
}

export function buildPerFilePayloads(reviewContext, options = {}) {
  const readFile = options.readFile ?? defaultReadFile(reviewContext.repoRoot);
  const budgetTokens = options.budgetTokens ?? 8_000;

  return reviewContext.changedFiles
    .filter((file) => !isSecretPath(file))
    .map((file) => {
      const content = readFile(file) ?? "(Datei nicht lesbar)";
      const head = [
        `Branch: ${reviewContext.branch}`,
        `Review-Ziel: ${reviewContext.target.label}`,
        `Teil-Review fuer genau eine Datei: ${file}`,
        ""
      ].join("\n");
      const block = `## Datei: ${file}\n\n\`\`\`\n${content}\n\`\`\`\n`;
      const text = `${head}${block}`;
      return {
        file,
        text: estimateTokens(text) > budgetTokens ? `${head}${block.slice(0, budgetTokens * 4)}\n(gekuerzt)\n` : text
      };
    });
}

export function mergeFindings(results) {
  const findings = [];
  const nextSteps = [];
  let verdict = "approve";

  for (const result of results) {
    if (!result) {
      continue;
    }
    if (result.verdict === "needs-attention") {
      verdict = "needs-attention";
    }
    findings.push(...(result.findings ?? []));
    nextSteps.push(...(result.next_steps ?? []));
  }

  return { verdict, summary: "", findings, next_steps: [...new Set(nextSteps)] };
}
