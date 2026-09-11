// Einzige Quelle fuer die Dateien, die typischerweise Zugangsdaten enthalten
// (Spec Abschnitt 10). Bewusst ein eigenes Blattmodul ohne Abhaengigkeiten:
// git.mjs sammelt diese Inhalte gar nicht erst ein, context.mjs benennt die
// Auslassung im Report -- beide brauchen dieselbe Liste, und git.mjs darf nicht
// von context.mjs abhaengen, weil die Architektur-Abhaengigkeit andersherum
// laeuft.

export const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\..+)?$/i
];

export function isSecretPath(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, "/");
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Exklusions-Pathspecs fuer genau die uebergebenen Pfade, die isSecretPath
// markiert -- nicht fuer ein Glob-Muster, das diesen Regexes nur aehnelt. Ein
// Glob, der mehr trifft als isSecretPath, wuerde Dateien aus dem Diff werfen,
// die der Report anschliessend nicht als ausgelassen benennt: eine stille
// Auslassung, also genau der Fehler, den dieser Filter verhindern soll.
// "literal" schaltet jede Sonderzeichendeutung im Pfad ab, "top" verankert ihn
// an der Repo-Wurzel.
export function secretExcludePathspecs(files) {
  return files.filter((file) => isSecretPath(file)).map((file) => `:(exclude,top,literal)${file}`);
}
