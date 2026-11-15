# Kamera-Webprotokoll v1/v2: isolierter Vertragsstand

Dieser WIP führt den früheren v2-Testpfad auf den Videomaker-Hauptstand zurück.
Er ändert kein Featureflag: Kamera-Endpunkte bleiben nur mit Test-Opt-in im
Entwicklungs-/Testmodus erreichbar und im Produktionsmodus 404. Keine UI wird
für diese Arbeit neu aktiviert. Android-WIP:
`wip/camera-contract-v2-android-20261115`.

Der Server akzeptiert alte `remote-record-v1`-Meldungen und zusätzlich
`remote-record-v2` mit explizitem Pausen- und Kamerarichtungszustand. Erweiterte
Steuerung setzt ein authentifiziertes Gerät voraus. Pause/Fortsetzen beziehen
sich auf dieselbe Web-Aufnahme und ihren offenen Projektclaim; ein Wechsel
bindet die erwartete bisherige Kameraseite und ist nur bei gemeldetem,
umschaltbarem Stillstand zulässig. Befehlsidentitäten sind für Wiederholungen
an Inhalt und Gerät gebunden. Ein belegter Stopp hat Priorität und bleibt auf
die konkrete Aufnahme beschränkt. Eine Quittung ist eine Geräteentscheidung,
kein Beweis für eine fertige Aufnahme, den tatsächlichen Objektivwechsel oder
den Cloud-Upload.

`tests/fixtures/camera-v1-v2-contract.json` ist bytegleich mit der Android-
Testressource und hat SHA-256
`ebb2f0915ca91b88e3ffd17fa4824fc49de75ced3ccf055347f5a9768cde2fb0`.
Die Tests verwenden echte Parser und synthetische SQLite-Daten; sie prüfen
unter anderem v1-Rückfall nach v2, falsche Feldtypen, Zustandskonflikte,
Stopppriorität, spätere und doppelte ACKs sowie ID-Konflikte.

Die bisherigen Freigabeblocker in `camera-production-readiness.md` gelten
unverändert. Insbesondere ersetzen diese Unit- und Parserprüfungen keine
unabhängige Prüfung von Schlüssel-/Sessionbindung, Retention, Absturz- und
Restoreverhalten, konkurrierender lokaler Bedienung oder reale E2E-Tests.
Der Android-Client wirbt weiterhin nur v2 an; dieser WIP beweist keinen
Client-Fallback auf v1. Ein etwaiges früheres HTTP- oder Gerätetestergebnis gilt
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
