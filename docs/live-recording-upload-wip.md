# Live-Aufnahme-Upload: unvollständiger Teststand

Dieser Stand ist nicht produktiv freigegeben. Die experimentelle Route bleibt bei
`NODE_ENV=production` immer 404. Bis zu einem vollständigen End-to-End-Test muss
KontraPrompter die fertige Aufnahme lokal behalten und den bewährten manuellen
Uploadpfad verwenden.

Die vorbereitete Protokollversion speichert genau eine private Stagingdatei pro
Aufnahme. SQLite enthält ausschließlich Aufnahme-/Projektbindung, Chunkindex,
Revision, Größe, Hash und Zustand; es speichert keine Videobytes. Ein Stück ist
höchstens 1 MiB groß, alle Stücke vor dem letzten sind vollständig. Ein Schreib-
Intent wird vor der Dateimutation gespeichert; nach Datei-`fsync` wird die
neue Revision bestätigt. Ein bei Absturz unterbrochener Schreibversuch bleibt
unbestätigt und darf mit dem gleichen erwarteten Vorzustand erneut oder nach
einem MP4-Rewrite mit den aktuellen Daten übertragen werden. Status liest und
hasht die tatsächlichen Dateibereiche erneut. Ein abweichendes Stück wird als
`invalid`, ein unterbrochenes als `writing` gemeldet. Das Versiegeln liest alle
Bytes erneut und verlangt lückenlose Teile sowie den vom Smartphone gelieferten
Gesamt-SHA-256. Bis dahin entsteht keine Zeile in `project_recordings`.

Die API akzeptiert nur den derzeitigen authentifizierten Einzeladministrator,
Same-Origin bei Mutationen und ausdrücklich `X-Live-Origin: lan`. Der bestehende
Gerätenachweis für per Web gestartete Kameraaufnahmen wird dadurch nicht ersetzt.
Es gibt höchstens acht nicht veröffentlichte Vorgänge; unvollständige Kopien
werden nicht automatisch gelöscht. Ein ausdrücklicher Abbruch ist vorgesehen.
Die vorhandene 512-MiB-Speicherreserve und laufende Uploadreservierungen werden
vor jedem Teil geprüft. Bei Platzmangel bleibt das Original auf dem Smartphone.

**Noch offen:** abschließender unabhängiger Sicherheitsreview, Tests mit echtem
Prozessabbruch an allen Festplatten-/SQLite-Grenzen, vollständige HTTP- und
Gerätetests, MP4-/Tonprüfung, Ende-zu-Ende-Test für atomare Veröffentlichung,
erneutes Finalisieren nach verlorenem ACK und Zusammenwirken mit dem normalen
Upload. Die hier enthaltene Veröffentlichungsroutine ist noch nicht geprüft;
eine `published`-Bestätigung darf nicht als produktionsfähig betrachtet werden.
