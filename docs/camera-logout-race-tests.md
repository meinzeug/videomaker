# Isolierter HTTP-Test: Logout und Kameraanfragen

`tests/camera-logout-race-integration.test.mjs` prüft, dass zwei vor einem Logout begonnene, erst danach vervollständigte Anfragen abgelehnt werden: eine Pairing-Challenge und ein Kamera-START. Beim START meldet sich zusätzlich ein getrennt angemeldetes synthetisches Gerät mit echtem P-256-Schlüssel und Ticket; es darf keinen Befehl erhalten.

Der Test erzeugt Projekte, Sessions und Geräteschlüssel und darf ausschließlich gegen eine separate lokale Entwicklungs-Fixture mit leerem temporären Datenverzeichnis ausgeführt werden. Er ist in `npm test` standardmäßig übersprungen. Ein Beispiel für die Fixture in einem eigenen Terminal:

```sh
CAMERA_FIXTURE_DIR=$(mktemp -d /tmp/videomaker-camera-auth-test.XXXXXX)
DATA_DIR="$CAMERA_FIXTURE_DIR" ADMIN_PASSWORD=camera-local-test \
SESSION_SECRET=local-camera-auth-test-secret-32-characters-minimum \
CAMERA_REMOTE_TEST_ENABLE=1 CAMERA_PREVIEW_TEST_ENABLE=1 \
npm run dev -- -H 127.0.0.1 -p 3332
```

Wenn der Server bereit ist, in einem zweiten Terminal:

```sh
CAMERA_AUTH_TEST_SERVER=http://127.0.0.1:3332 CAMERA_AUTH_TEST_ALLOW_WRITES=1 \
node --experimental-strip-types --test tests/camera-logout-race-integration.test.mjs
```

Danach den Fixture-Server beenden und nur das eigens erstellte temporäre Verzeichnis entfernen. Niemals `DATA_DIR` eines bestehenden Studios verwenden. Die Tests wärmen die Routen vor und halten eine JSON-Anfrage während der Abmeldung offen; die kurze Wartezeit hilft der Ablaufsteuerung, beweist aber nicht jede mögliche Thread- und Worker-Reihenfolge. Die echte Kamera, ein nativer Medienstream und parallele Servergenerationen werden damit nicht getestet.

Beim isolierten Lauf am 14. November 2026 bestanden beide Logout-Racetests. Auch die vorhandenen HTTP-Tests für P-256-Pairing, Vorschau und Kameraaufnahmen bestanden mit den Änderungen. Zuvor waren beide Races reproduziert worden: Die Challenge wurde nach Logout noch ausgestellt und ein nach Logout angenommener START erreichte das synthetische Gerät. Nach der Korrektur antworteten beide verzögerten Anfragen mit 403; das Gerät erhielt keinen Befehl. Das ist kein Test gegen den Produktivserver.
