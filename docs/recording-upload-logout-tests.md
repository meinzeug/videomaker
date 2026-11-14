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

## Android-Gerätetest mit isolierter Fixture (14.11.2026)

Auf dem Samsung Galaxy A52 wurde eine separate Test-App mit eigener App-ID und Test-CA im Hintergrund per Android-Instrumentation ausgeführt. Sie nutzte den echten `StudioClient.uploadRecording` und ein künstlich erzeugtes, vollständig dekodierbares MP4 mit Bild und Ton (1.407.212 Bytes). Das Testvideo und zwei eigens angelegte Projekte gehörten ausschließlich der Fixture. Ein normaler Upload und seine identische Wiederholung wurden anhand des Serverbelegs bestätigt.

Bei einem zweiten Upload hielt der lokale HTTPS-Testproxy nach dem ersten Datenblock an und wartete, bis der Server die betreffende Uploadsperre angelegt hatte. Er meldete danach **dieselbe Testsitzung** ab und leitete den Rest weiter. Der Server antwortete mit 403; zu diesem Zeitpunkt gab es für die betreffende Upload-ID weder einen Aufnahme-Datenbankeintrag noch eine veröffentlichte Datei oder einen dauerhaften Intent-Marker. Das lokale Testvideo blieb erhalten und hatte denselben SHA-256-Wert. Nach erneuter Anmeldung gelang ein Retry mit derselben Upload-ID. Die beiden Serverdateien stimmten anschließend in Größe und SHA-256 mit dem künstlichen Original überein; jedes Testprojekt enthielt genau einen Aufnahme-Eintrag.

Die HTTPS-Signalisierung lief über einen ausschließlich für den Test eingerichteten ADB-Reverse-Port und eine lokale Test-CA. Die isolierte Next-Entwicklungsfixture verwendete den fest konfigurierten Origin `https://127.0.0.1:9445` einschließlich passendem Host, also den konfigurierten Origin-Prüfmodus. Der produktive Server und echte Nutzeraufnahmen wurden nicht als Testziel verwendet. Die reguläre Samsung-Kamera blieb während der Hintergrund-Instrumentation geöffnet; das Xiaomi blieb in der regulären App. Test-App, eigener ADB-Reverse-Port, Proxy, Testserver und Testdaten wurden anschließend entfernt. Der Versuch belegt **keine** echte Kameraaufnahme im Test, keine WLAN-Transportprüfung, keinen Upload über die reguläre App-Oberfläche und keinen Produktionsupload.

Die letzte Sitzungsprüfung, das dauerhafte Anlegen beziehungsweise Prüfen des Intent-Markers und die Dateiregistrierung laufen gemeinsam unter einem SQLite-Schreiblock. Ein verwaister Marker oder Dateilink bleibt bei COMMIT-Fehler für einen späteren autorisierten Retry erhalten. Ist der Upload bereits vor Abschluss des Logouts registriert oder sein Beleg geprüft, wird er durch die Abmeldung nicht rückgängig gemacht; eine verspätete Antwort kann nach dem Logout eintreffen oder für den Client unklar bleiben. Der Client muss nach erneuter Anmeldung denselben Upload anhand seiner ID und Prüfsumme erneut prüfen können. Eine vorher begonnene Datenübertragung wird durch den Logout nicht sofort abgebrochen und kann bis zum Abschlusscheck temporär auf Platte geschrieben werden; nach erfolgreich abgeschlossenem Logout wird sie durch die alte Sitzung weder dauerhaft markiert noch veröffentlicht oder bestätigt. Ein Dateisystemaufruf innerhalb des Schreiblocks kann den Abschluss des Logouts verzögern. Die lokale Aufnahme auf dem Android-Gerät bleibt unabhängig davon erhalten.
