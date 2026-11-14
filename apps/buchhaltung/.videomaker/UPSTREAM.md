# Haben-Updates für Video-Maker

`upstream.json` hält den importierten Stand fest. Der Originalquelltext liegt im Hauptrepository;
Die Patches in `patches/` dokumentieren die Änderungen gegenüber genau diesem Upstream-Commit.
`LICENSE` und `NOTICE` müssen auch bei jedem Update erhalten und geprüft werden.

Für einen Update-Kandidaten zunächst einen **separaten**, sauberen Git-Klon von
`https://github.com/firsttris/haben.git` auf einen konkreten, geprüften Commit auschecken. Dann
`prepare-update.sh /pfad/zum/separaten/klon VOLLSTAENDIGER_COMMIT` ausführen. Das Skript prüft
Repository, Arbeitsverzeichnis und Commit und spielt die Integrationspatches dort ein. Konflikte
werden nicht automatisch aufgelöst. Es installiert nichts, startet keine Dienste, verändert keine
Datenbank und kopiert nichts in Video-Maker.

Anschließend Quelländerungen und Lizenzbedingungen prüfen, Patchserie gegebenenfalls angepasst
erneuern, Version und Commit in `upstream.json` aktualisieren, alle relevanten Tests einschließlich
Migration, Wiederherstellung, Anmeldung, Upload, Schnittstellen und Browserbedienung ausführen und
den geprüften Stand regulär ins Hauptrepository übernehmen. Für die Produktionsübernahme braucht es
vorher einen vollständigen getesteten Backup-/Rollback-Plan. Ein künftiger Button in den Einstellungen
ist nur eine Oberfläche für diesen überprüfbaren Ablauf und darf kein ungeprüftes Git-Pull oder eine
automatische Datenbankmigration im laufenden Betrieb auslösen.

Ein Git-Subtree erleichtert Upstream-Merges und bewahrt deren Historie im Hauptrepository, vergrößert
aber die Historie und macht eine Konfliktprüfung weiterhin nötig. Die hier gewählte Patchserie hält den
genauen Unterschied und eine überprüfbare Update-Vorbereitung sichtbar; bei inkompatiblen Upstream-
Änderungen muss sie bewusst angepasst werden.
