# Isolierter Test: Abmeldung während Aufnahme-Upload

`tests/recording-upload-logout-integration.test.mjs` unterbricht synthetische Uploads nach dem ersten Chunk, meldet die verwendete Sitzung ab und überträgt danach den Rest. Er prüft den Abschluss eines neuen Uploads, den erneuten Upload einer bereits gespeicherten Datei und die Wiederherstellung einer verwaisten Datei nach einem injizierten SQLite-COMMIT-Fehler. Ein zusätzlicher synthetischer Kamera-READY-Claim prüft, dass ein widerrufener Retry weder einen Uploadbeleg erzeugt noch die Kamera-Projektzuordnung abschließt. Ein gültig angemeldeter Client kann dieselben Bytes anschließend erneut übertragen und erhält den passenden SHA-256-Beleg.

Der Test erzeugt Testprojekte und Aufnahmedateien. Er darf nur mit einer eigenen lokalen Datenbank ausgeführt werden, niemals gegen ein bestehendes Studio. Er akzeptiert ausschließlich `127.0.0.1:3389`, ein markiertes temporäres Datenverzeichnis sowie das ausdrückliche Schreib-Flag. Vor dem ersten HTTP-Upload legt der Test ein zufällig benanntes synthetisches Projekt in der markierten Datenbank an und prüft über den Server, dass genau dieses Projekt lesbar ist.

In einem eigenen Terminal:

```sh
RECORDING_LOGOUT_FIXTURE_DIR=$(mktemp -d /tmp/videomaker-recording-logout-fixture.XXXXXX)
printf 'isolated-recording-logout\n' > "$RECORDING_LOGOUT_FIXTURE_DIR/.recording-logout-fixture"
printf '%s\n' "$RECORDING_LOGOUT_FIXTURE_DIR"
DATA_DIR="$RECORDING_LOGOUT_FIXTURE_DIR" ADMIN_PASSWORD=recording-logout-local-test \
SESSION_SECRET=recording-logout-test-secret-12345678901234567890 \
npm run dev -- -H 127.0.0.1 -p 3389
```

In einem zweiten Terminal den zuvor angezeigten Verzeichnispfad einsetzen:

```sh
RECORDING_LOGOUT_FIXTURE_DIR=/tmp/videomaker-recording-logout-fixture.XXXXXX \
RECORDING_LOGOUT_TEST_SERVER=http://127.0.0.1:3389 RECORDING_LOGOUT_TEST_ALLOW_WRITES=1 \
node --experimental-strip-types --test tests/recording-upload-logout-integration.test.mjs
```

Danach den Fixture-Server beenden und nur das eigens angelegte Testverzeichnis entfernen. Im isolierten Lauf bestanden alle Abläufe; ein verzögerter Fremdschlüssel löste den SQLite-Fehler beim tatsächlichen COMMIT aus. Ein Gerätestopp oder ein Produktions-Upload wurde damit nicht getestet. Ergänzend bestanden die bestehenden isolierten HTTP-Serien für Prüfsumme, konkurrierende Uploads, fsync-Fehler und Lease-Verlust. Eine konkurrierende gleiche ID darf den bereits bestehenden Konfliktcode `camera_upload_busy` liefern; ein späterer Retry mit denselben Bytes muss den vorhandenen Beleg zurückgeben.

Die letzte Sitzungsprüfung, das dauerhafte Anlegen beziehungsweise Prüfen des Intent-Markers und die Dateiregistrierung laufen gemeinsam unter einem SQLite-Schreiblock. Ein verwaister Marker oder Dateilink bleibt bei COMMIT-Fehler für einen späteren autorisierten Retry erhalten. Ist der Upload bereits vor Abschluss des Logouts registriert oder sein Beleg geprüft, wird er durch die Abmeldung nicht rückgängig gemacht; eine verspätete Antwort kann nach dem Logout eintreffen oder für den Client unklar bleiben. Der Client muss nach erneuter Anmeldung denselben Upload anhand seiner ID und Prüfsumme erneut prüfen können. Eine vorher begonnene Datenübertragung wird durch den Logout nicht sofort abgebrochen und kann bis zum Abschlusscheck temporär auf Platte geschrieben werden; nach erfolgreich abgeschlossenem Logout wird sie durch die alte Sitzung weder dauerhaft markiert noch veröffentlicht oder bestätigt. Ein Dateisystemaufruf innerhalb des Schreiblocks kann den Abschluss des Logouts verzögern. Die lokale Aufnahme auf dem Android-Gerät bleibt unabhängig davon erhalten.
