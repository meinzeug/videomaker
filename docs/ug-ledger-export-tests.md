# Isolierter Journal-Exporttest

Der HTTP-Test legt echte, unveränderliche Testkonten und Testbuchungen an. Er darf nie gegen ein bestehendes Studio laufen. Er akzeptiert nur `127.0.0.1:3335`, ein eigens angelegtes und markiertes temporäres Datenverzeichnis sowie das ausdrückliche Schreib-Flag. Vor dem ersten schreibenden HTTP-Aufruf legt er in der markierten Testdatenbank ein zufälliges Konto an und bestätigt, dass die angesprochene Instanz exakt dieses Konto liest. Wenn die Datenbanken nicht übereinstimmen, bricht er ab.

Für den Test zwei Terminals verwenden. Im ersten ein neues Verzeichnis anlegen, markieren und den Server starten:

```sh
LEDGER_EXPORT_FIXTURE_DIR=$(mktemp -d /tmp/videomaker-ledger-export-fixture.XXXXXX)
printf 'isolated-ug-export-fixture\n' > "$LEDGER_EXPORT_FIXTURE_DIR/.ug-export-fixture"
printf '%s\n' "$LEDGER_EXPORT_FIXTURE_DIR"
DATA_DIR="$LEDGER_EXPORT_FIXTURE_DIR" ADMIN_PASSWORD=ledger-local-test \
SESSION_SECRET=local-ledger-export-test-secret-123456789 \
npm run dev -- -H 127.0.0.1 -p 3335
```

Im zweiten Terminal den vom ersten angezeigten Verzeichnispfad einsetzen:

```sh
LEDGER_EXPORT_FIXTURE_DIR=/tmp/videomaker-ledger-export-fixture.XXXXXX \
LEDGER_EXPORT_TEST_SERVER=http://127.0.0.1:3335 LEDGER_EXPORT_TEST_ALLOW_WRITES=1 \
node --experimental-strip-types --test tests/ug-ledger-export-integration.test.mjs
```

Danach den Testserver beenden und nur das eigens angelegte temporäre Verzeichnis entfernen. Der Unit-Test verwendet zusätzlich eine eigene SQLite-WAL-Datenbank und prüft einen Commit zwischen zwei Exportseiten.

Zusätzlich kann mit `RUN_CALC_EXPORT_TEST=1 node --experimental-strip-types --test tests/ug-ledger-export-calc-integration.test.mjs` ein Test mit lokalen LibreOffice- und unzip-Installationen gestartet werden. Er erzeugt ausschließlich synthetische Buchungen und ein eigenes temporäres LibreOffice-Profil, importiert die CSV in Calc, speichert ODS und öffnet diese Datei erneut für einen XLSX-Export. Die enthaltenen Tabellen dürfen keine Formelzellen enthalten, die maskierten Zeichen müssen erhalten bleiben. Der Test belegt das Verhalten der jeweils installierten LibreOffice-Version, nicht das von Microsoft Excel oder anderen Tabellenprogrammen.

Der Test wurde lokal erfolgreich mit LibreOffice 25.2.7.2 ausgeführt; die maskierten Testtexte blieben im XLSX erhalten und weder ODS noch XLSX enthielten Formelzellen.
