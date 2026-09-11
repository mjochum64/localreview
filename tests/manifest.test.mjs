import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("plugin manifest names the plugin localreview", () => {
  const plugin = readJson("plugins/localreview/.claude-plugin/plugin.json");
  assert.equal(plugin.name, "localreview");
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
});

test("marketplace points at the plugin directory", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].source, "./plugins/localreview");
  assert.equal(marketplace.plugins[0].name, "localreview");
});

test("no manifest mentions codex", () => {
  const raw = [
    fs.readFileSync(path.join(repoRoot, "plugins/localreview/.claude-plugin/plugin.json"), "utf8"),
    fs.readFileSync(path.join(repoRoot, ".claude-plugin/marketplace.json"), "utf8")
  ].join("\n");
  assert.equal(/codex/i.test(raw), false);
});

// Die Namensvorgabe galt bisher als Prosa und wurde von zwei JSON-Dateien
// geprueft. Durchgesetzt hat sie damit, wer zufaellig hinsah: der
// Default-Praefix in fs.mjs hat fuenfzehn Task-Reviews ueberlebt. Erlaubt ist
// genau die Attributionszeile, die Spec Abschnitt 12 fuer die portierten Module
// vorschreibt -- alles andere ist ein Befund.
const ATTRIBUTION_LINE = "// Derived from openai/codex-plugin-cc.";

function listFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    });
}

test("no source file mentions codex outside the attribution header", () => {
  // Diese Datei selbst ist ausgenommen: sie muss den gesuchten Namen im
  // Klartext enthalten, um nach ihm suchen zu koennen.
  const self = url.fileURLToPath(import.meta.url);
  const offenders = [];

  for (const file of [...listFiles(path.join(repoRoot, "plugins")), ...listFiles(path.join(repoRoot, "tests"))]) {
    if (file === self) {
      continue;
    }
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/codex/i.test(line) && line.trim() !== ATTRIBUTION_LINE) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      });
  }

  assert.deepEqual(offenders, []);
});
