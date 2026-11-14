# Isolierter HTTP-Test für Finanzzuordnungen

Der Test legt echte, unveränderliche Testkonten, Buchungen und Finanzvorgänge an. Er darf nie gegen ein bestehendes Studio laufen. Er akzeptiert nur `127.0.0.1:3336`, ein eigens angelegtes und markiertes temporäres Datenverzeichnis sowie das ausdrückliche Schreib-Flag. Vor dem ersten schreibenden HTTP-Aufruf legt er in der markierten Testdatenbank ein zufälliges Konto an und bestätigt, dass die angesprochene Instanz exakt dieses Konto liest. Bei unterschiedlichen Datenbanken bricht er ab.

Im ersten Terminal eine neue Fixture starten:

```sh
LEDGER_LINKS_FIXTURE_DIR=$(mktemp -d /tmp/videomaker-ledger-links-fixture.XXXXXX)
printf 'isolated-ug-links-fixture\n' > "$LEDGER_LINKS_FIXTURE_DIR/.ug-links-fixture"
printf '%s\n' "$LEDGER_LINKS_FIXTURE_DIR"
DATA_DIR="$LEDGER_LINKS_FIXTURE_DIR" ADMIN_PASSWORD=ledger-local-test \
SESSION_SECRET=local-ledger-links-test-secret-123456789 \
npm run dev -- -H 127.0.0.1 -p 3336
```

Im zweiten Terminal den angezeigten Verzeichnispfad einsetzen:

```sh
LEDGER_LINKS_FIXTURE_DIR=/tmp/videomaker-ledger-links-fixture.XXXXXX \
LEDGER_LINKS_TEST_SERVER=http://127.0.0.1:3336 LEDGER_LINKS_TEST_ALLOW_WRITES=1 \
node --experimental-strip-types --test tests/ug-ledger-finance-links-integration.test.mjs
```

Danach den Testserver beenden und nur das eigens angelegte temporäre Verzeichnis entfernen. Der Test prüft Anmeldung, Origin-Schutz, idempotente Zuordnung und Korrektur, konkurrierende Ereignisse und verzögerte Anfragen nach Logout; er ersetzt keine fachliche Prüfung von Buchhaltung oder Steuern.

Zuordnungs- und Korrekturanfragen erhalten dauerhafte Belege. Ihr Speicherbedarf wächst mit jeder angenommenen Anfrage; eine geprüfte begrenzte Aufbewahrung existiert noch nicht. Diese Belege nicht einfach löschen: Späte Wiederholungen könnten dadurch ihre verlässliche Entscheidung verlieren.
