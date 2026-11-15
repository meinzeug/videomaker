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
