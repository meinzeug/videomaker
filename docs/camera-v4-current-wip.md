# Kameravertrag v4: isolierte Übertragung auf Web-main

Dieser WIP überträgt die Vertragsänderungen aus `d981d8b` selektiv auf
`4dca746`. Der alte Branch wird nicht gemergt: Die neueren Lösch-Tombstones,
der Streaming-Löschschutz und bestehende Uploadrouten bleiben unverändert.
Die produktiven Kamerarouten bleiben durch das bestehende Testmodus-Prädikat
gesperrt; der passende separate Android-WIP ist `6ad6470` mit ebenfalls
abgeschalteter Kamerafunktion. Es handelt sich nicht um eine Freigabe.

Die Änderung bindet Befehlszustellung und Quittung dauerhaft an Geräte- und
Protokollversion, schützt Pause/Fortsetzen mit Aufnahme- und Projektbindung,
behandelt unklare Geräteentscheidungen dauerhaft als `uncertain` und stellt
für STOP ein aufnahmegebundenes, wiederholbares Verfahren bereit. Ein START
mit `enqueued` ist lediglich auf dem Kamera-Executor eingereiht: Weder eine
aktive Aufnahme noch eine fertige Cloud-Datei ist damit bestätigt. STOP darf
auch während einer ausstehenden START-Anfrage angeboten werden, wenn ein
konkreter aktiver Take tatsächlich beobachtet wurde.

Neue Vertrags-/UI-/STOP-Tests sind enthalten. Die getrennten HTTP-Fixtures
`scripts/test-camera-versioned-http.py` und `scripts/test-camera-v4-http.py`
verwenden ausschließlich diesen WIP, synthetische Daten und einen lokalen
Server; sie benötigen vorhandene lokale Abhängigkeiten, freien Platz und einen
freien Port. Sie verändern und restaurieren hierfür zeitweise nur die lokale
Fixturekonfiguration. Sie wurden auf dieser neuen Quellkombination noch nicht
ausgeführt; insbesondere sind die früheren Tests auf `d981d8b` kein Nachweis
für diesen Stand. SIGKILL oder Stromausfall können temporäre Fixturedateien
hinterlassen.

Vor Freigabe fehlen unabhängiger Review sowie echte Geräte-/Browser-/Recorder-
Tests mit Netzwerk-/Prozessfehlern, späten Antworten und Mischversionen. Die
sichere Auflösung von `uncertain`, Anti-Downgrade- und Backup-Restore-Schutz,
Schlüsselverlust, Quoten/Archivierung und Preview-Widerruf bleiben offen. Der
bestehende lokale Notstopp und die lokale Aufnahme haben Vorrang.
