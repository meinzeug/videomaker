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

Der zusätzliche Linux-Prozessabbruchtest erzeugt seine eigene temporäre Datenbank, startet einen gemockten lokalen Server auf einem freien Loopback-Port, beendet ausschließlich dessen eigene Prozessgruppe und startet ihn mit derselben Testdatenbank neu:

```sh
GENERATION_RESTART_TEST_ALLOW_WRITES=1 node --experimental-strip-types --test tests/generation-claims-restart-integration.test.mjs
```

Er prüft, dass ein bei laufender KI-Anfrage abgebrochener Server nach Neustart keinen zweiten Anbieteraufruf auslöst. Der Test verwendet keinerlei Produktionsdaten oder echte Anbieteraufrufe.

Die gespeicherte Recherche bindet neue Aufträge an den damals ausgewählten Kanal und seine Angaben. Alte Berichte ohne diese Bindung bleiben lesbar und nutzbar; bei ihnen kann ein Kanal ausdrücklich nachgewählt werden. Wird der Kanal zwischen Recherche und Abschluss verändert oder entfernt, wird das fertige Skript ohne Zuordnung gespeichert und ein dauerhafter Hinweis angezeigt. Eine Prüfung der Begrüßung kann bestimmte offensichtliche Abweichungen melden, erkennt aber nicht zuverlässig jede falsche Kanalnennung. JSON-Kodierung und die Anweisung, Kanalangaben als Daten zu behandeln, sind keine technische Garantie gegen Prompt-Injection. Eine manuelle inhaltliche Prüfung bleibt erforderlich.

Vor dem KI-Aufruf reserviert der Server die Recherche dauerhaft in SQLite. Gleichzeitige oder wiederholte Anfragen für dieselbe Recherche starten keinen zweiten Skriptaufruf. Die erhaltene Antwort wird vor der Projekterstellung gespeichert; ein bereits gespeichertes Ergebnis lässt sich nach einem Neustart ohne erneuten Skriptaufruf fertigstellen. Bildplanung und gegebenenfalls Bilderzeugung können dabei eigene KI-Aufrufe und Kosten verursachen; sie sind nicht durch den Skript-Claim geschützt. Projekt und Abschluss werden gemeinsam gespeichert; bereits erstellte oder gelöschte Projekte werden nicht automatisch neu angelegt. Offene Aufträge und eine gegebenenfalls gespeicherte KI-Antwort sind im Dashboard nach Anmeldung auffindbar. Die Antworten bleiben wie die übrigen Studio-Daten auf dem Server und müssen im Backup- und Aufbewahrungskonzept berücksichtigt werden.

Eine Anfrage, für die nicht nachweisbar eine Antwort gespeichert wurde, bleibt absichtlich ungeklärt und wird nicht automatisch wiederholt. Insbesondere kann der Prozess abstürzen, nachdem der Anbieter Arbeit geleistet oder eine Antwort gesendet hat, aber bevor der Server diese dauerhaft speichert; die bestehende Anbieterintegration hat hierfür keinen nachgewiesenen Ergebnisabruf. In diesem Fenster kann eine Antwort verloren gehen, und der Claim bleibt gesperrt. Ein späterer neuer Rechercheauftrag kann erneut Kosten verursachen. Die Claims dürfen nicht einfach gelöscht oder durch ein älteres Backup zurückgesetzt werden: Beides könnte alte Aufträge wiederholbar machen. Eine geprüfte, begrenzte Aufbewahrung sowie ein Restore-Verfahren zur Erhaltung der Claims fehlen noch. Die Funktion ist kein Nachweis, dass der Anbieter selbst exakt einmal abrechnet.

Eine nach Logout erfolgreich gespeicherte Anbieterantwort bleibt für die spätere Fertigstellung erhalten und startet noch kein Projekt. Für den Projektabschluss wird die Sitzung innerhalb derselben SQLite-Schreibtransaktion erneut geprüft. Bereits begonnene Anbieteraufrufe können dadurch nicht zurückgeholt werden. Die Bildarbeit startet nach dem Projekt-Commit; bei mehreren Serverprozessen kann Logout zwischen Commit und Bildstart liegen. Ein sofortiger allgemeiner Logout-Widerruf laufender Bildjobs ist nicht implementiert.
