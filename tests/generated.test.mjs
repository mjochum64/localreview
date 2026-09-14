import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { GENERATED_LINE_LENGTH, isGeneratedContent } from "../plugins/localreview/scripts/lib/generated.mjs";

const REPO_ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

test("flags content with a single machine-length line", () => {
  assert.equal(isGeneratedContent(`kurz\n${"x".repeat(GENERATED_LINE_LENGTH)}\nkurz`), true);
  assert.equal(isGeneratedContent("x".repeat(GENERATED_LINE_LENGTH)), true);
});

test("leaves ordinary source untouched", () => {
  assert.equal(isGeneratedContent("const a = 1;\nconst b = 2;\n"), false);
  assert.equal(isGeneratedContent(""), false);
  assert.equal(isGeneratedContent(null), false);
  assert.equal(isGeneratedContent("x".repeat(GENERATED_LINE_LENGTH - 1)), false);
});

// Eine lange, aber normal umbrochene Datei ist review-bar und darf nicht in
// diesen Filter laufen -- sie kostet nur Budget, und dafuer gibt es die
// Platzgruende-Auslassung in context.mjs.
test("does not flag a long file that is merely wrapped normally", () => {
  assert.equal(isGeneratedContent("const line = 1;\n".repeat(50_000)), false);
});

// Die Schwelle stammt aus einer Messung an diesem Repo: die laengste Zeile im
// laengsten handgeschriebenen Text lag bei 383 Zeichen. Bricht jemand diesen
// Abstand durch eine neu eingecheckte Datei, soll der Test das melden, statt
// den Filter stillschweigend auf echten Quelltext loszulassen.
test("keeps a wide margin above everything hand-written in this repository", () => {
  const sources = [
    "README.md",
    "README.de.md",
    "plugins/localreview/scripts/review-companion.mjs",
    "plugins/localreview/scripts/lib/git.mjs",
    "plugins/localreview/scripts/lib/context.mjs",
    "plugins/localreview/scripts/lib/client.mjs"
  ];
  for (const source of sources) {
    const content = fs.readFileSync(path.join(REPO_ROOT, source), "utf8");
    assert.equal(isGeneratedContent(content), false, `${source} darf nicht als generiert gelten`);
  }
});
