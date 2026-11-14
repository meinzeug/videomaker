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

## Lokaler Browser-Build, 14.11.2026

Der Versuch, den aktuellen Haben-Webstand für einen isolierten Browsertest zu
bauen, wurde bei vollem Swap und nur noch rund 531 MiB verfügbarem RAM
kontrolliert beendet. Die unvollständige Ausgabe unter
`/tmp/videomaker-haben-next/apps/buchhaltung/apps/web/.output` darf nicht als
fertiger Build verwendet werden. Der Testbuild erzeugte außerdem den
Compiler-Cache `/home/dennis/.videomaker-guard-pg18.Fc066Q/node-compile-cache`
(rund 25 MiB). Die automatische Freigabeprüfung lehnte den gezielten
Löschbefehl ab; beide Ausgaben bleiben unverändert liegen. Ein weiterer
vollständiger Build braucht ausreichend Speicher und einen abgesprochenen
Buildslot. Der echte OIDC-Dienst-/Haben-Callback-Test mit isoliertem
PostgreSQL 18 ist unabhängig davon bestanden; ein echter Browser-/Proxytest
des vollständigen Haben-Dashboards steht aus. Ein kleinerer Fixture mit echtem
Browser, lokalem Testproxy, echtem OIDC-Dienst und Haben-Auth-Handler ist
inzwischen bestanden; seine Seite und der interne TLS-Gegenserver sind
simuliert, die internen HTTPS-Clients und deren CA-Prüfung sind echt.
