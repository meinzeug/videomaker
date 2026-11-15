# Kamera-Webprotokoll v1/v2/v3: isolierter Vertragsstand

Dieser WIP führt den früheren v2-Testpfad auf den Videomaker-Hauptstand zurück.
Er ändert kein Featureflag: Kamera-Endpunkte bleiben nur mit Test-Opt-in im
Entwicklungs-/Testmodus erreichbar und im Produktionsmodus 404. Keine UI wird
für diese Arbeit neu aktiviert. Android-WIP:
`wip/camera-contract-v2-android-20261115`.

Der Server akzeptiert alte `remote-record-v1`- und `remote-record-v2`-Meldungen.
Projektgebundenes Pause/Fortsetzen wird nur an ausdrücklich `remote-record-v3`
meldende, authentifizierte Geräte ausgegeben. Pause/Fortsetzen beziehen
sich auf dieselbe Web-Aufnahme und ihren offenen Projektclaim; ein Wechsel
bindet die erwartete bisherige Kameraseite und ist nur bei gemeldetem,
umschaltbarem Stillstand zulässig. Befehlsidentitäten sind für Wiederholungen
an Inhalt und Gerät gebunden. Ein belegter Stopp hat Priorität und bleibt auf
die konkrete Aufnahme beschränkt. Eine Quittung ist eine Geräteentscheidung,
kein Beweis für eine fertige Aufnahme, den tatsächlichen Objektivwechsel oder
den Cloud-Upload.

`tests/fixtures/camera-v1-v3-contract.json` ist bytegleich mit der Android-
Testressource und hat SHA-256
`d56a49423098b3452ad90925105852da75cea2500209c42f03d3e10a8609d6cd`.
Die Tests verwenden echte Parser und synthetische SQLite-Daten; sie prüfen
unter anderem v1-Rückfall nach v3, falsche Feldtypen, Zustandskonflikte,
Stopppriorität, spätere und doppelte ACKs sowie ID-Konflikte.

Die bisherigen Freigabeblocker in `camera-production-readiness.md` gelten
unverändert. Insbesondere ersetzen diese Unit- und Parserprüfungen keine
unabhängige Prüfung von Schlüssel-/Sessionbindung, Retention, Absturz- und
Restoreverhalten, konkurrierender lokaler Bedienung oder reale E2E-Tests.
Der Android-WIP meldet v3 und fällt nicht still auf v1/v2 zurück. Ein etwaiges früheres HTTP- oder Gerätetestergebnis gilt
nicht automatisch für diesen zusammengeführten Quellstand.

## Projektbindung und verbleibende Aktionsgrenze

Pause und Fortsetzen werden beim Anlegen an das zum Aufnahme-Claim gehörende
Projekt gebunden. Vor jeder Auslieferung prüft der Server im selben
SQLite-Schreiblock Aufnahme, Projekt und weiterhin offenen Claim; nie
ausgelieferte ungebundene Altbefehle werden abgelehnt. Bereits ausgelieferte
Aufträge werden bei einem späteren Zustandswechsel nicht fälschlich als
abgelehnt bezeichnet. Android prüft dasselbe Projekt im Entscheidungsjournal
und innerhalb des Recorder-Locks gegen das bei Aufnahmezulassung gespeicherte
Projekt. Der separate Not-/Recovery-Stopp erhält keine neue Projektpflicht.

Die Android-Journalentscheidung `accepted` wird weiterhin vor dem
Recorderaufruf gespeichert. Verweigert der Recorder-Lock die Aktion wegen
eines zwischenzeitlich veränderten Zustands, wird dessen `false` derzeit nicht
crashsicher in diese Entscheidung zurückgeschrieben. Eine solche Quittung
belegt deshalb keine tatsächlich zugelassene Aktion. Dieser Race und das
Verhalten nach Prozessabbruch bleiben vor Aktivierung ein Freigabeblocker.
Ältere Journalentscheidungen ohne Projekt bleiben lesbar, können aber keinen
neuen Pause-/Fortsetzen-Auftrag ohne Projekt autorisieren.

## STOP-Namespace und Mischversionen

Neue Nicht-STOP-Befehle dürfen keine UUIDv8 als Befehls-ID verwenden; dieser
Bereich bleibt für aufnahmegebundene STOP-IDs reserviert. Das ist eine
bewusste Einschränkung bisher beliebig gültiger IDs; reguläre `randomUUID()`-
Clients erzeugen UUIDv4. Wenn historische, bereits gespeicherte Fremdbefehle
eine deterministische STOP-ID belegen, wählt der Server im gleichen
Schreiblock eine freie deterministische Alternative und behält diese im
Stoppplatz für Wiederholungen. Er prüft dabei bekannte Serverbefehle und
aktuelle STOP-Plätze; ein unsichtbares oder zurückgerolltes Gerätejournal und
ein schon früher vergifteter belegter STOP-Platz bleiben ungeklärte Fälle.
Die sichere STOP-/Recovery- und Aufbewahrungsintegration ist weiter offen.

Ein v2-Gerät bekommt keinen v3-Pause-/Fortsetzen-Auftrag. Ältere Server können
die v3-Meldung ablehnen. Android behandelt HTTP 400 und unpassende Antworten
in diesem WIP als Protokollproblem im Poll-Loop; ein echter Test bei laufender
Aufnahme und die Behandlung aller weiteren Fehlersituationen stehen noch aus.

## Wiederholbarer lokaler HTTP-Test

Am 15. November 2026 bestand `python3 scripts/test-camera-versioned-http.py`
auf dem Stand `cc75f8f` mit einem synthetischen P-256-Gerät und eigener
SQLite-Datenbank. Der Test prüft Registrierung, Ticket, v3-Status, Start,
Pause/Fortsetzen, Kamerawechsel, Stopp und Logout über den lokalen HTTP-Dienst;
seine frühere Bezeichnung „v2“ wurde anschließend im Testtitel korrigiert.
Er beweist keinen Android-Gerätetest, kein aktives Produktivflag und keine
Freigabe der ungeklärten `accepted`-/Crash-Grenze.

Das Skript ist absichtlich auf den separaten Worktree
`/home/dennis/.videomaker-camera-contract-v2` und `127.0.0.1:3392` begrenzt.
Es erwartet ein verfügbares lokales `node_modules`, unveränderte
`next.config.ts`/`next-env.d.ts` und einen freien Port. Es erzeugt unter dem
Home-Verzeichnis ein markiertes synthetisches Datenverzeichnis, setzt Test-Opt-in
und künstliche Zugangsdaten nur für den Kindprozess und setzt einen temporären
Turbopack-Root, damit das lokale Modulverzeichnis auflösbar bleibt. Der
Next-Prozess ist auf 768 MiB Node-Heap und der Test auf 384 MiB begrenzt; nach
30 Sekunden ohne erreichbaren eigenen Server bzw. nach 150 Sekunden Testzeit
wird abgebrochen. Der Port-Inhaber muss zur gestarteten Prozessgruppe gehören.
Bei normalem Ende, Fehler, SIGINT und SIGTERM stoppt das Skript seinen Dienst,
stellt unveränderte Konfigurationen wieder her und entfernt nur sein markiertes
Testverzeichnis. Bei unerwartet gleichzeitig geänderten Konfigurationen werden
Originale und Testverzeichnis zur manuellen Prüfung erhalten. SIGKILL,
Systemabsturz oder Stromausfall können Cleanup verhindern: In diesem Fall
Prozess und Marker prüfen und nur die eigene Fixture bereinigen. Keine
Produktionsdaten oder fremde laufende Prozesse verwenden.

## Unklare Geräteentscheidung (v4, nicht freigegeben)

Der Android-WIP schreibt bei Start, Pause, Fortsetzen und Kamerawechsel vor
Aufruf der LiveSession einen nicht quittierbaren Zustand `admitting`. Nach
einer positiven Rückgabe wird für Start `enqueued` und für andere Aktionen
`accepted` gespeichert; eine negative Rückgabe,
Ausnahme oder ein Neustart vor dem zweiten Speicherschritt wird `uncertain`.
Ein solches Kommando wird nicht erneut ausgeführt. `enqueued` belegt bei Start lediglich die Einreihung am Kamera-Executor,
keine Recorder-Zulassung. `accepted` bedeutet bei anderen Aktionen lediglich
die erfolgreiche Rückgabe des Geräts, weder eine fertige Datei noch einen
erfolgreichen Cloud-Upload. STOP bleibt ein eigener, wiederholbarer,
aufnahmegebundener Notpfad. Ein Fehler des Journals selbst bleibt ein gesonderter
Sicherheitsfall und wird nicht als harmlose Netzwerkstörung abgefangen.

Nur ein authentifizierter v4-Heartbeat darf `uncertain` für ein zuvor an genau
dieses Gerät geliefertes Kommando melden. Der WIP-Server hält den Zustand in
einer unveränderlichen Zusatztabelle fest, liefert keine anderen Aktionen mehr
und zeigt ihn im Dashboard an; STOP bleibt vor dieser Sperre. Späte positive
Quittungen lösen diese Sperre nicht auf. Ein geprüfter, dauerhafter manueller
Auflösungsweg fehlt: Der Zustand bleibt deshalb gesperrt. Auch nach Rückkehr zu
einem älteren Server bzw. Android besteht keine Zusicherung, dass dessen
Verhalten dieselbe Sicherheit bietet; Freischaltung und Rollback bleiben bis
zur vollständigen Prüfung gesperrt.

Die SQLite- und Kotlin-Modelltests sind synthetisch. AtomicFile-Ausfall zwischen
Geräteaktion und Journalabschluss, Prozessabsturz, tatsächliche LiveSession,
HTTP-Mischversionen, Android-Komplettbuild und Aufnahme auf Geräten sind damit
nicht nachgewiesen. Bei unerkannter Transport-/Authentifizierungsantwort hält
der Android-WIP die Websteuerung an, ohne den Recorder-Owner zu schließen;
bekannte Kompatibilitäts- und IO-Fehler werden weiterhin im Loop behandelt.

Das Dashboard lässt im WIP STOP auch während einer noch ausstehenden
Start-HTTP-Anfrage zu, wenn es für dasselbe ausgewählte Gerät einen konkreten
aktiven Take gemeldet bekommen hat. Ein älteres Startergebnis kann eine neuere
STOP-Anzeige nicht überschreiben. Der Server prüft den Take zusätzlich. Bereits
zugestellte Startbefehle lassen sich damit nicht zurückholen; deren Parallelität
zu einem späteren Stopp ist weiterhin ein Freigabeblocker. Die UI-Tests bilden
Promise-Reihenfolgen synthetisch ab und ersetzen keinen Browser-/Gerätetest.

Der isolierte v4-HTTP-Vertragstest `python3 scripts/test-camera-v4-http.py`
bestand am 15. November 2026 auf `dbf9311` mit künstlicher P-256-Identität und
eigener Datenbank. Er prüfte v3/v4-Meldungen, die Ablehnung eines v3-Ungewiss-
Belegs, die dauerhafte v4-Sperre, ein spätes positives ACK und anschließenden
STOP. Das Skript verwendet ausschließlich den WIP
`~/.videomaker-camera-admission-v4`, Port 3393 und ein markiertes temporäres
Verzeichnis. Wie beim v3-Test gelten Zeitlimits, Prozessgruppenprüfung und
Cleanup; bei SIGKILL oder Stromausfall können Reste eine manuelle Prüfung
benötigen. Das ist kein Android-/Browser-Gerätetest und keine Produktionsfreigabe.

Die Zustellung eines neuen Befehls wird im selben SQLite-Schreibvorgang dauerhaft
an Geräte-ID und Protokollversion gebunden. Ein ACK einer anderen Version kann
den Zustand nicht setzen; eine erneute Zustellung an eine andere Version wird
unterdrückt. Schon vor der Migration zugestellte Aufträge ohne belegbare Version
werden weder erneut zugestellt noch als v4-Beleg interpretiert. Bei START ist
`enqueued` dauerhaft, unterdrückt Wiederholung und wird im Dashboard als bloße
Einreihung gezeigt. Ein echter asynchroner Recorder-Zulassungsbeleg fehlt.

Nach Ergänzung von `enqueued` und Versionsbindung bestand der isolierte
HTTP-Test erneut. Zusätzlich geprüft wurden ein v4-START, ein verworfenes
v3-ACK, die sichtbare Warteschlangeneinreihung und die anschließende tatsächliche
Aufnahmetelemetrie. Die Prüfung simuliert das Gerät und belegt keinen nativen
Recorder-Start.
