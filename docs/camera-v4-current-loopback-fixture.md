# Isolierte Web-/Android-v4-Fixture

Dieser Testbranch auf `88b2d84` dient ausschließlich dem synthetischen
Gerätetest. `scripts/camera-device-loopback-e2e.py` verwendet eine eigene
Datenbank und Zugangsdaten, den Android-Testbranch `563df32`, ein separates
Testpaket und lokales HTTPS mit einer eigens erzeugten Test-CA. Er prüft vor
Verwendung APK-Hashes, Paketnamen, CA-Zuordnung, Gerätezustand, Ports und die
bestehenden ADB-Reverse-Regeln; nur eigene Regeln und Pakete werden entfernt.
Bei wenig Speicher oder unerwarteten Änderungen bricht er ab. Die produktiven
Kameraflags bleiben gesperrt, der Produktivserver ist kein Testziel.

Die Fixture simuliert Recorderereignisse und einen verlorenen ACK-Response;
sie testet weder einen echten Recorder, Kamera, Ton, WLAN-Reconnect noch ein
Rollback. Nach SIGKILL/Stromausfall können isolierte Testreste eine manuelle
Prüfung erfordern. Kein Gerätetest ist auf dieser Version bisher behauptet.

Am 15. November 2026 bestand die Fixture auf Samsung SM-A526B (13,561 s,
Runner `7b73b26`) und Xiaomi 2409BRN2CY über WLAN-ADB (16,012 s, Runner
`9d2700e`). Beide Test-APKs stammten aus Android-Fixture `563df32` und CI
`43692046702`. Der Test verwendete eigene Geräteidentität, lokales HTTPS und
synthetische Recorderereignisse. Er bestätigte einen nach Serverannahme
verlorenen `enqueued`-ACK-Response sowie dessen Wiederholung aus dem Android-
Journal. Das erste Xiaomi-Fixture-Installieren wurde durch MIUI abgewiesen;
anschließend wurde nur der Dialog für das genau benannte Testpaket bestätigt.

Die gesonderten Pakete und ADB-Reverse-Regeln wurden entfernt; die anfänglich
und anschließend leeren Reverse-Listen stimmten überein. Der eigene Next-Dienst
wurde beendet. Beide normalen Apps waren wieder im Vordergrund, Xiaomi meldete
die Videoverbindung und Anmeldung, Samsung die Studioverbindung. Der Test
belegt weiterhin keine echte Recorder-/Codecaufnahme und keine Freigabe.
