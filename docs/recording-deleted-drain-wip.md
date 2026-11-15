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

## Produktivübernahme und echter Gerätetest am 15. November

Der CI-gebaute Stand `4dca746` wurde nach separatem Test mit synthetischer
Datenbank und Streamingproxy produktiv übernommen. Eine geprüfte Online- und
eine zusätzliche SQLite-Sicherung nach Dienststopp wurden angelegt; der
vorherige vollständige Stand blieb als Rückweg erhalten. Nach dem Start waren
alle zuvor vorhandenen 21 Projekte und 34 Aufnahmen vorhanden. Health,
Anmeldung, Projektzugriff und der vollständige APK-Download bestanden.

Ein realer Wiederholungsversuch vom Xiaomi für eine eigene, zuvor auf dem
Server gelöschte 4.821.928 Bytes große Testaufnahme zeigte nun die spezifische
Löschmeldung statt „Connection reset“. Die lokale Exportdatei blieb mit der
vor der Löschung bestätigten SHA-256
`0ec9b39904ed8b55cd768f4010f9e7fa4fb3f66efe49a611de291e7b5789a2ba`
erhalten; auf dem Server blieben Aufnahmezeile und Datei entfernt, die
Löschsperre blieb bestehen. Anschließend wurde nach erneuter WLAN-Kopplung
Start, Pause, Fortsetzen und Stopp einer weiteren Kameraaufnahme über das
Samsung geprüft; diese wurde automatisch hochgeladen. Sehr große oder langsame
Wiederholungen können wegen der dokumentierten Uploadfristen weiter abbrechen.
