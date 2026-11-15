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
