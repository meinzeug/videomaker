# Isolierter Android-/Server-Loopback-Test

Dieser Branch ist eine Testkopie. `scripts/camera-device-loopback-e2e.py`
akzeptiert ausschließlich die beiden ausdrücklich vorgesehenen Testgeräte,
separat installierte `.journalfixture`-APKs mit vorab übergebenen SHA-256-Hashes
und die nur für den Test erzeugte lokale CA. Er verwendet die Next-Testkopie,
eine synthetische Datenbank und ein temporäres Passwort. Die Android-App zeigt
nur auf HTTPS-Loopback; die produktive App und der produktive Server sind nicht
Teil der Fixture. Die CA-Schlüssel liegen ausschließlich im temporären
Testverzeichnis und dürfen nicht eingecheckt werden.

Der Runner wählt freie lokale Testports dynamisch und reserviert auf dem
ausgewählten Gerät `tcp:3395` mit `adb reverse --no-rebind`. Er hält die ursprünglichen
ADB-Reverse-Regeln fest und entfernt nur die unverändert passende eigene Regel.
Bestehende gleichnamige Testpakete oder belegte Ports führen zum Abbruch.
Das Xiaomi muss zuvor sichtbar `Aufnahme starten` anzeigen. Der Runner nutzt
keinen echten Recorder, sondern ein synthetisches Recorderereignis; er prüft den
realen Android-Ereignishandler, das Journal, den StudioClient und den Zustand
der lokalen Webroute. Die Systemdialoge auf Xiaomi werden nur bei exakt
passendem Fixture-Paket bestätigt. Testpakete und Daten werden anschließend
entfernt; unerwartet veränderte Konfigurationen werden für eine manuelle
Prüfung erhalten.

Vor dem Start müssen auf dem Home-Dateisystem mindestens 512 MiB und in `/tmp`
mindestens 256 MiB frei sein. Die bisherigen vergleichbaren Next-Läufe nutzten
etwa 20 MiB Cache; für diese Fixture sind vorsorglich bis 250 MiB veranschlagt.
Ein Überwachungsfaden bricht bei weniger als 384 MiB auf dem Home-Dateisystem
ab und startet die Bereinigung. SIGKILL, Systemabsturz oder unerwartete externe
Änderungen können eine manuelle Nachprüfung erforderlich machen. Der Test
beweist keine tatsächliche Kamera-/Codecaufnahme, keine Produktivfreigabe und
keine Sicherheit beim Zurückrollen auf ältere App-/Serverstände.
