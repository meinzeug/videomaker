# Live-Upload: Testvorbereitung auf aktuellem main

Dieser separate Worktree basiert auf `32f61b5`. Die neuen `live-recording-*`-
Module und die Route wurden aus dem deaktivierten WIP `c6313e9` übernommen;
die bestehende Claim-Prüfung erhielt nur die dafür notwendige symmetrische
Live-Staging-Sperre. Unter `NODE_ENV=production` bleibt die Route immer 404.
Die getrennte Android-Testvorbereitung liegt unter
`/home/dennis/.kontraprompter-live-main-fixture/tests/live-upload-fixture`.

Noch wurde dieser Stand weder kompiliert noch getestet. Die vorhandenen Tests
sind ältere Fixture-Quellen und müssen zunächst gegen aktuelle Authentisierung,
Projekt-Claims und Upload-Limits überprüft werden. Für den Ende-zu-Ende-Test
muss ein eigener Loopback-Server mit eigener SQLite-Datenbank, eigenem
Testpasswort und eindeutig markiertem temporären Datenverzeichnis gestartet
und nach dem Lauf gestoppt werden. Niemals bestehende Dienste oder Daten nutzen.

Der nächste Lauf soll Netzwerkabbruch während eines Chunks, echten SIGKILL des
eigens gestarteten Kotlin-Clients nach Commit und vor Empfang des Belegs,
Neustart mit ausschließlich lesender Receipt-Abfrage, umgeschriebene MP4-
Bytes und Hashgleichheit prüfen. Das gegenseitige Fencing mit dem regulären
Vollupload braucht ergänzende Tests und einen sicheren Übergabepfad. Die Route,
der Server-Commit, Ressourcenlimits und Wiederherstellung nach Festplatten-/
SQLite-Abstürzen bleiben bis zu eigenständigem Review und Praxistests WIP.
