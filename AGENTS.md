<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Videomaker als Hauptprojekt

Dieses Repository ist das **Hauptrepository** der Videomaker-Inselsoftware für die Medienagentur. Videomaker ist die gemeinsame Plattform für kanal- und plattformübergreifende Planung, Skripte, Produktion, Medienverwaltung und weitere Agenturprozesse. Vorhandene Funktionen und Daten sind bei Erweiterungen zu erhalten.

KontraPrompter ist eine zugehörige Untersoftware und Android-App, die im Hauptprojekt als Teleprompter und für die Smartphone-Produktion genutzt wird. Ihr eigenständiges Repository liegt lokal unter `~/kontraprompter` und auf GitHub unter `meinzeug/kontraprompter`. Das Videomaker-Hauptrepository liegt lokal unter `~/videomaker` und auf GitHub unter `meinzeug/videomaker`; der laufende Videomaker ist unter `https://videomaker.dorfspy.de` erreichbar.

Bei Änderungen an gemeinsamen Abläufen, Datenformaten, Anmeldung oder Schnittstellen sind **beide Projekte gemeinsam zu berücksichtigen**: die betroffenen Stellen in beiden Repositories prüfen, erforderliche Änderungen koordinieren und die Interaktion möglichst Ende zu Ende testen. Ein vorhandenes Teilprojekt darf nicht als unabhängig vom Agentursystem behandelt werden. Weitere Unterprojekte sind hier mit Repository, lokalem Pfad und Funktion zu ergänzen, sobald sie hinzukommen.

Die vom Projekt vorgegebene Gestaltungsreferenz liegt unter `~/kontraprompter/SKILL.md`. Bei der Gestaltung der Oberflächen deren anwendbare Prinzipien beachten; Android- und Web-Oberflächen sollen zugänglich, gut bedienbar und in ihren gemeinsamen Abläufen konsistent sein. Nicht implementierte Funktionen und Grenzen müssen in Oberfläche und Dokumentation erkennbar bleiben.

Produktivdaten, Serverkonfiguration und bestehende Aufnahmen schützen. Vor einer Serverübernahme Änderungen prüfen, Sicherung und Rückweg vorbereiten sowie anschließend die betroffenen Funktionen und den Dienstzustand kontrollieren. Projektanweisungen und Git-Status in beiden Repositories vor Änderungen beachten.
