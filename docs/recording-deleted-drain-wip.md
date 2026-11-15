# Gelöschte Aufnahme: Antwort nach beendetem Uploadstream

Bei einem bereits bestehenden Aufnahme-Tombstone verwirft der isolierte WIP
einen zulässigen Uploadstream ohne Datei oder dauerhaft gespeicherte Inhalte.
Der Stream belegt einen der zwei vorhandenen Uploadslots. Die Session wird
während des Lesens auch bei ausbleibenden Bytes und vor dem Rückgabewert
geprüft. Der abschließende Session- und Tombstonecheck erfolgt unter demselben
SQLite-Writerlock wie ein Logout. Nur nach vollständig gelesenem Body meldet
der Server `409` mit `recording_deleted`.

Der WIP begrenzt den verworfenen Body auf 1 GiB, die Wartezeit auf 30 Sekunden
ohne Daten und die Gesamtzeit auf zehn Minuten. Bei Abbruch, zu langsamer
Übertragung, fehlender Session oder verlorener Lease ist eine 409-Antwort
nicht garantiert; je nach Zeitpunkt kann die Gegenstelle erneut einen
Verbindungsabbruch sehen. Ein Retry von 1 GiB überträgt bis zu 1 GiB über das
Netz und benötigt in zehn Minuten mindestens etwa 1,7 MiB/s. Zwei parallele
Retries können beide regulären Uploadslots bis zu zehn Minuten belegen. Lease-
und Sessionchecks beanspruchen SQLite auch während des Lesens. Eine separate,
authentifizierte Vorabprüfung könnte Bandbreite sparen, muss aber die
anschließende Übertragung weiterhin gegen Löschung absichern; sie ist hier
nicht implementiert.

## Isolierte Prüfung

`node --experimental-strip-types --test tests/recording-deleted-drain.test.mjs`
testet Vollständigkeit und Größenlimit, Widerruf vor/nach Read und während
eines blockierten Lesens, verlorene Lease, Idle- und Gesamtfrist sowie einen
4,8-MB-Stream über echte lokale HTTP-Sockets. Darüber hinaus liefen die vier
Tests `tests/recording-deletion-integration.test.mjs` mit synthetischer SQLite-
Datenbank und Dateien in `/dev/shm` gegen die tatsächlichen Next-Routen über
einen lokalen Streaming-Reverse-Proxy. Darunter sind ein vollständig
übertragener 4,8-MB-Retry mit 409/JSON und ein konkurrierender Löschvorgang.

Für die Entwicklungsfixture waren wegen extern liegender Abhängigkeiten
Webpack `resolve.symlinks=false`, `NODE_PATH` und vorübergehend ausgeschaltete
Startinstrumentierung erforderlich. Next-Konfiguration, Instrumentierung und
`next-env.d.ts` sind danach wiederhergestellt. Der Node-Proxy ist nicht Caddy;
dessen Pufferung und ein echter Android-Client sind hier nicht getestet. Keine
Produktivdaten, Geräte oder Server wurden für diesen Test verwendet.
