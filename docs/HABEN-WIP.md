# Arbeitsstand: Haben-Anbindung

Dieser Zweig ist ein unfertiger Integrationsstand und darf nicht produktiv
ausgerollt werden. Die bisherige Finanzoberfläche wurde hier bereits aus dem
Quelltext entfernt, während die neue Buchhaltung noch nicht für den Einsatz
bereitsteht. Auf `main` bleibt die bisherige Oberfläche bis zur sicheren
Umstellung erhalten.

Offen sind insbesondere die gemeinsame Anmeldung und der sichere Nachweis der
Gegenstelle zwischen den Diensten, die native Produktionsinstallation samt
PostgreSQL 18, Sicherung und Wiederherstellung, die sichere Behandlung lokaler
Browser-Warteschlangen sowie Ende-zu-Ende-Tests der Buchhaltungsfunktionen.
Der optionale Sitzungsschutz ist standardmäßig ausgeschaltet. Der Update-Knopf
ist bis zur geprüften harten Speicherbegrenzung deaktiviert; eine geprüfte
Übernahme und Datenbankmigration werden noch nicht automatisch ausgeführt.

Das Entfernen alter Datenbanktabellen ist ein separater, ausdrücklich geprüfter
Schritt. Vorher müssen die Browser-Warteschlangen geprüft und Daten gesichert
werden. Siehe `docs/remove-legacy-finance.md` und
`apps/buchhaltung/.videomaker/ANMELDUNG.md`.
