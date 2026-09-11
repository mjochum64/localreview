import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { collectReviewContext, resolveReviewTarget } from "../plugins/localreview/scripts/lib/git.mjs";
import { buildReviewPayload } from "../plugins/localreview/scripts/lib/context.mjs";
import { secretExcludePathspecs } from "../plugins/localreview/scripts/lib/secrets.mjs";

const COMPANION = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../plugins/localreview/scripts/review-companion.mjs"
);

// Der Wert, nicht der Dateiname, ist der Beweis: der Report benennt die
// ausgelassenen Dateien ohnehin. Ein Test, der nur prueft, dass ".env" in
// secretFiles auftaucht, ist genau der Test, der den Leak nicht gesehen hat.
const ENV_VALUE = "SUPERSECRET123";
const KEY_VALUE = "MIIBOGLEAK";

function assertNoSecrets(text, label) {
  assert.equal(text.includes(ENV_VALUE), false, `${label} enthaelt den .env-Wert`);
  assert.equal(text.includes(KEY_VALUE), false, `${label} enthaelt den Private-Key-Inhalt`);
}

// includeDiff wird ueberall explizit gesetzt: der Default haengt an
// maxInlineFiles (2), und mit drei geaenderten Dateien faellt collectReviewContext
// von allein in den Modus ohne eingebetteten Diff -- der Test wuerde dann gruen
// sein, ohne den Leak-Pfad ueberhaupt zu betreten.
function reviewOf(cwd, target, options = {}) {
  const reviewContext = collectReviewContext(cwd, target, { includeDiff: true, ...options });
  return { reviewContext, payload: buildReviewPayload(reviewContext, { budgetTokens: 100_000 }) };
}

function seedRepo() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "sub"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "a.txt"), "erste Zeile\n", "utf8");
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=platzhalter\n", "utf8");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

test("secret pathspecs cover exactly the flagged files", () => {
  assert.deepEqual(secretExcludePathspecs(["a.txt", ".env", "sub/server.key", "src/environment.js"]), [
    ":(exclude,top,literal).env",
    ":(exclude,top,literal)sub/server.key"
  ]);
  assert.deepEqual(secretExcludePathspecs(["a.txt"]), []);
});

test("a modified tracked secret file never reaches the payload", () => {
  const cwd = seedRepo();
  fs.writeFileSync(path.join(cwd, ".env"), `SECRET=${ENV_VALUE}\n`, "utf8");
  fs.writeFileSync(path.join(cwd, "a.txt"), "zweite Zeile\n", "utf8");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const { reviewContext, payload } = reviewOf(cwd, target);

  assert.deepEqual(payload.secretFiles, [".env"]);
  assertNoSecrets(reviewContext.content, "reviewContext.content");
  assertNoSecrets(payload.text, "payload.text");
  // Der Rest des Diffs muss vollstaendig ankommen: der Filter darf nicht mehr
  // wegwerfen als die Secret-Datei.
  assert.match(payload.text, /zweite Zeile/);
});

test("an untracked secret file never reaches the payload", () => {
  const cwd = seedRepo();
  fs.writeFileSync(path.join(cwd, "sub", "server.key"), `-----BEGIN KEY-----\n${KEY_VALUE}\n`, "utf8");
  fs.writeFileSync(path.join(cwd, "a.txt"), "zweite Zeile\n", "utf8");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const { reviewContext, payload } = reviewOf(cwd, target);

  assert.deepEqual(payload.secretFiles, ["sub/server.key"]);
  assertNoSecrets(reviewContext.content, "reviewContext.content");
  assertNoSecrets(payload.text, "payload.text");
  assert.match(payload.text, /zweite Zeile/);
});

test("a secret file in a branch diff never reaches the payload", () => {
  const cwd = seedRepo();
  run("git", ["checkout", "-b", "feature"], { cwd });
  fs.writeFileSync(path.join(cwd, ".env"), `SECRET=${ENV_VALUE}\n`, "utf8");
  fs.writeFileSync(path.join(cwd, "sub", "server.key"), `-----BEGIN KEY-----\n${KEY_VALUE}\n`, "utf8");
  fs.writeFileSync(path.join(cwd, "a.txt"), "zweite Zeile\n", "utf8");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const { reviewContext, payload } = reviewOf(cwd, target);

  assert.deepEqual(payload.secretFiles, [".env", "sub/server.key"]);
  assertNoSecrets(reviewContext.content, "reviewContext.content");
  assertNoSecrets(payload.text, "payload.text");
  assert.match(payload.text, /zweite Zeile/);
});

// Ohne eingebetteten Diff (viele oder sehr grosse Dateien) baut git.mjs einen
// leichtgewichtigen Kontext -- aber untracked-Dateien werden auch dort vollstaendig
// eingebettet, also muss der Filter auch auf diesem Pfad greifen.
test("the lightweight context inlines no untracked secret either", () => {
  const cwd = seedRepo();
  fs.writeFileSync(path.join(cwd, "sub", "server.key"), `-----BEGIN KEY-----\n${KEY_VALUE}\n`, "utf8");
  fs.writeFileSync(path.join(cwd, ".env"), `SECRET=${ENV_VALUE}\n`, "utf8");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const { reviewContext, payload } = reviewOf(cwd, target, { includeDiff: false });

  assertNoSecrets(reviewContext.content, "reviewContext.content");
  assertNoSecrets(payload.text, "payload.text");
  assert.deepEqual(payload.secretFiles, [".env", "sub/server.key"]);
});

// Nach dem Filter oben ist der Diff einer reinen Secret-Aenderung leer. Ohne diese
// Abkuerzung liefe ein Review gegen einen Payload ohne Inhalt und meldete am Ende
// "approve" -- ein Freispruch fuer etwas, das nie geprueft wurde.
test("a diff that changes only secret files is refused instead of approved", () => {
  const cwd = seedRepo();
  fs.writeFileSync(path.join(cwd, ".env"), `SECRET=${ENV_VALUE}\n`, "utf8");
  const dataDir = makeTempDir();

  const result = run("node", [COMPANION, "review", "--json", "--wait", "--cwd", cwd], {
    env: {
      ...process.env,
      LOCALREVIEW_BASE_URL: "http://127.0.0.1:1/v1",
      LOCALREVIEW_MODEL: "m1",
      CLAUDE_PLUGIN_DATA: dataDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.nothingToReview, true);
  assert.equal(payload.verdict, undefined);
  assert.deepEqual(payload.secretFiles, [".env"]);
});
