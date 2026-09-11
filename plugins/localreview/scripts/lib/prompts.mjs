import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const MODULE_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(MODULE_DIR, "..", "..", "schemas", "review-output.schema.json");

export const REVIEW_SCHEMA_NAME = "review_output";

export function loadReviewSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
}

export function buildInstructions({ focus = null } = {}) {
  const base = [
    "Du bist ein read-only Code-Reviewer.",
    "Du bewertest ausschliesslich den gezeigten Diff und die mitgelieferten Dateien.",
    "Du schreibst keinen Patch und behauptest nicht, Aenderungen vorgenommen zu haben.",
    "Melde nur Befunde, die du im gezeigten Code belegen kannst; erfinde keine Datei- oder Zeilenangaben.",
    "Ist nichts Belastbares zu finden, gib verdict \"approve\" mit leerer findings-Liste zurueck."
  ].join("\n");

  if (!focus || !String(focus).trim()) {
    return base;
  }

  return [base, "", "FOKUS (ausdruecklicher Wunsch des Nutzers):", String(focus).trim()].join("\n");
}

export function buildReduceInstructions() {
  return [
    "Du erhaeltst die gesammelten Befunde mehrerer Teil-Reviews eines einzelnen Branches.",
    "Fasse sie zu einer knappen summary und hoechstens fuenf next_steps zusammen.",
    "Erfinde keine neuen Befunde und lasse keinen vorhandenen weg."
  ].join("\n");
}
