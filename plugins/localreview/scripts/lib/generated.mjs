// Einzige Quelle fuer die Erkennung maschinell erzeugter Dateien. Bewusst ein
// eigenes Blattmodul ohne Abhaengigkeiten, genau wie secrets.mjs: context.mjs
// haengt daran, nicht umgekehrt.
//
// Warum die laengste Zeile und nicht Dateigroesse oder Zeilendichte: im eigenen
// Repo gemessen taugt die durchschnittliche Zeilenlaenge nicht -- das generierte
// 720-KB-Diagramm kam auf 48.4 Zeichen je Zeile, README.md auf 44.6, und
// Zeilen hatte es mit 14880 reichlich. Die laengste Zeile trennt dagegen sauber:
// 26586 Zeichen gegen 383 im laengsten handgeschriebenen Text des Repos.
// GENERATED_LINE_LENGTH liegt damit gut fuenfmal ueber allem von Hand
// Geschriebenen und weit unter dem Artefakt.
//
// Die Dateigroesse allein waere das falsche Mass: eine lange, aber normal
// umbrochene Quelldatei ist review-bar, sie kostet nur Budget -- dafuer gibt es
// die Platzgruende-Auslassung in context.mjs.
export const GENERATED_LINE_LENGTH = 2000;

// Anders als bei Zugangsdaten ist das eine Heuristik, keine Gewissheit. Sie darf
// deshalb nur auslassen, was der Report anschliessend auch benennt -- eine
// stille Auslassung waere hier schlimmer als eine teure Datei im Payload.
export function isGeneratedContent(content) {
  const text = String(content ?? "");
  let start = 0;

  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    if (end - start >= GENERATED_LINE_LENGTH) {
      return true;
    }
    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }

  return false;
}
