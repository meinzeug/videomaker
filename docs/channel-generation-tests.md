# Isolierter HTTP-Mocktest der Kanal-Skripterstellung

Der Test erzeugt und löscht künstliche Kanäle, Recherchen und Skripte. Er darf nur mit einer eigenen lokalen Datenbank und niemals gegen ein bestehendes Studio ausgeführt werden. Ein lokaler Fetch-Mock ersetzt alle OpenRouter-Aufrufe; der Schlüsselwert ist bewusst ungültig. Der Test prüft unter anderem den alten Kontrakurs-Ablauf, die Kanalzuordnung, KI-Fehler sowie die Entfernung eines Kanals während eines laufenden KI-Auftrags. Bildplanungsaufrufe werden ebenfalls gemockt; ihre Testfehler betreffen keine echten Bilder.

In einem Terminal:

```sh
CHANNEL_GENERATION_FIXTURE_DIR=$(mktemp -d /tmp/videomaker-channel-fixture.XXXXXX)
printf 'isolated-channel-generation\n' > "$CHANNEL_GENERATION_FIXTURE_DIR/.channel-fixture"
printf '%s\n' "$CHANNEL_GENERATION_FIXTURE_DIR"
DATA_DIR="$CHANNEL_GENERATION_FIXTURE_DIR/data" CHANNEL_GENERATION_FIXTURE_DIR="$CHANNEL_GENERATION_FIXTURE_DIR" \
ADMIN_PASSWORD=channel-local-test SESSION_SECRET=channel-test-secret-12345678901234567890 \
OPENROUTER_API_KEY=invalid-mock-only NODE_OPTIONS="--require=$PWD/tests/fixtures/channel-generation-openrouter-mock.cjs" \
npm run dev -- -H 127.0.0.1 -p 3376
```

In einem zweiten Terminal den angezeigten Verzeichnispfad einsetzen:

```sh
CHANNEL_GENERATION_FIXTURE_DIR=/tmp/videomaker-channel-fixture.XXXXXX \
CHANNEL_GENERATION_TEST_SERVER=http://127.0.0.1:3376 CHANNEL_GENERATION_TEST_ALLOW_WRITES=1 \
node --experimental-strip-types --test tests/channel-generation-integration.test.mjs
```

Anschließend ausschließlich den Fixture-Server beenden und das eigens angelegte Fixture-Verzeichnis entfernen. Der Test enthält keine echte redaktionelle Prüfung und beweist nicht, dass eine reale KI-Anfrage alle Vorgaben erfüllt.

Die gespeicherte Recherche bindet neue Aufträge an den damals ausgewählten Kanal und seine Angaben. Alte Berichte ohne diese Bindung bleiben lesbar und nutzbar; bei ihnen kann ein Kanal ausdrücklich nachgewählt werden. Wird der Kanal zwischen Recherche und Abschluss verändert oder entfernt, wird das fertige Skript ohne Zuordnung gespeichert und ein dauerhafter Hinweis angezeigt. Eine Prüfung der Begrüßung kann bestimmte offensichtliche Abweichungen melden, erkennt aber nicht zuverlässig jede falsche Kanalnennung. JSON-Kodierung und die Anweisung, Kanalangaben als Daten zu behandeln, sind keine technische Garantie gegen Prompt-Injection. Eine manuelle inhaltliche Prüfung bleibt erforderlich.

Eine bereits bestehende Einschränkung bleibt: Parallele `/api/generate`-Anfragen mit derselben Recherche können vor Abschluss beide eine KI-Anfrage starten und zwei Projekte erstellen. Die Transaktion verhindert keinen doppelten KI-Aufruf; es gibt noch keinen dauerhaften, ausfallsicheren Claim. Solche Anfragen nicht parallel senden. Nach einer ausdrücklichen Fehlerantwort vor Beginn des Speichervorgangs kann die Skripterstellung im noch offenen Tab mit derselben Recherche erneut gestartet werden. Der Server bestätigt dafür, dass der Bericht noch vorhanden ist. Bei verloren gegangener Antwort oder unklarem Speicher-/COMMIT-Fehler wird kein Wiederholknopf angeboten; zunächst die gespeicherten Skripte prüfen. Die Wiederaufnahmemöglichkeit bleibt nicht über das Schließen oder Neuladen des Tabs erhalten.
