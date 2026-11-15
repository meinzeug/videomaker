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
`a157d167b02f64b10dbc544f6c79d851e54a048588cb2e310f4282249daa6ba5`.
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
