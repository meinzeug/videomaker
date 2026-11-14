# KontraPrompter-Download

Angemeldete Nutzer können die aktuell bereitgestellte KontraPrompter-Testversion über das Download-Symbol im Studio-Header herunterladen. Der Hinweis „DEBUG“ kennzeichnet den derzeit vorgesehenen Debug-Build. Der Download ist erst verfügbar, wenn eine APK bereitgestellt wurde; andernfalls erscheint eine Meldung.

Der Server liest ausschließlich die Datei `kontraprompter.apk` im privaten `DATA_DIR` (standardmäßig `./data`). Die Datei gehört nicht ins Git-Repository. Das Hochladen und Aktualisieren geschieht nicht automatisch: Bei jedem neuen Build muss eine geprüfte APK atomar an diesem Pfad bereitgestellt werden, damit der Download aktuell bleibt. Die Route prüft Dateigröße, Dateityp und ZIP-Kennung, aber weder Android-Signatur noch Version oder Vollständigkeit der APK; diese Prüfungen sind vor der Bereitstellung durchzuführen. Ein Debug-Build ist keine signierte Produktionsversion. Beim Umstieg auf eine Produktionsversion müssen die DEBUG-Kennzeichnung und der Download-Dateiname angepasst werden.

## Kandidat vorbereiten

`scripts/prepare-kontraprompter-apk.py` erstellt außerhalb des App-Repositories einen isolierten Build aus einem Git-Archiv. Es verweigert den Lauf, wenn verfolgte Dateien verändert sind, der Checkout nicht auf `main` steht oder der lokale Commit nicht mit GitHub-`main` übereinstimmt. Nach Build und JVM-Tests prüft es mit Android-`apksigner` und `aapt` Signatur, Paketname, Version und SHA-256 und kontrolliert den Git-Stand erneut. Der erwartete SHA-256-Fingerabdruck des **vertrauenswürdigen Signaturzertifikats** ist ausdrücklich anzugeben und separat zu verwalten; ein beliebiger Fingerabdruck aus der zu prüfenden APK ist keine Vertrauensgrundlage. Verwendet wird der lokal konfigurierte Debug-Schlüssel; seine private Datei darf nie ins Repository oder in den Kandidaten gelangen.

Das private Ausgabeverzeichnis muss bereits existieren und darf nur dem ausführenden Benutzer zugänglich sein. Beispiel mit eigenem, zuvor unabhängig überprüftem Zertifikatsfingerabdruck:

```sh
install -d -m 700 "$HOME/kontraprompter-kandidaten"
python3 scripts/prepare-kontraprompter-apk.py \
  --repo "$HOME/kontraprompter" --sdk "$HOME/Android/Sdk" \
  --output-dir "$HOME/kontraprompter-kandidaten" \
  --signer-sha256 PRUEFFINGERABDRUCK_IN_KLEINEN_HEXZEICHEN
```

Das Ergebnis ist ein Verzeichnis mit Commit-ID, `kontraprompter.apk` und `manifest.json`. Es wird nichts hochgeladen oder installiert. Scheitert ein Schritt, wird kein erfolgreicher Kandidat ausgewiesen. Bereits vorhandene Kandidaten werden nicht überschrieben; die atomare Ablage benötigt Linux und ein Dateisystem mit `renameat2(RENAME_NOREPLACE)`. Die Prüfung setzt die dauerhaft eingerichteten SDK-Build-Tools 35.0.0, eine passende Java-/Gradle-Umgebung und eine sichere Verbindung zum Git-Server voraus. Unverfolgte Dateien des App-Repositories werden beim Git-Archiv nicht übernommen.

Die erzeugte Datei wird vor ihrer Signatur- und Paketprüfung in das private Kandidatenverzeichnis kopiert. Dabei werden Symlinks, Spezialdateien und Dateien über 512 MiB abgewiesen; auch während des Kopierens gilt diese Obergrenze. Ihre Prüfsumme wird vor und nach diesen Prüfungen sowie vor der Ablage verglichen; erkennbare Änderungen brechen die Vorbereitung ab. Das ist keine Isolation gegen einen absichtlich manipulierenden Prozess mit denselben Benutzerrechten, der die Datei gezielt zwischen Prüfungen verändert. Für eine automatische Veröffentlichung braucht der Build daher einen getrennten, kontrollierten Benutzer beziehungsweise eine entsprechende Betriebssystemisolation. Der Build übernimmt außerdem die Umgebung des aufrufenden Prozesses und kann Gradle-Abhängigkeiten aus dem Netz laden; Git-Commit und Zertifikat allein belegen daher keinen reproduzierbaren Build.

## Atomarer Austausch

`scripts/install-kontraprompter-apk.py QUELLE DATA_DIR SHA256` ist ein separat ausführbarer Installer für eine zuvor vollständig geprüfte und über einen vertrauenswürdigen Kanal kopierte Datei. Er prüft Dateityp, ZIP-Kennung und den übergebenen Hash erneut, begrenzt die Größe und verwendet eine exklusive Sperre, eine private temporäre Datei im Zielverzeichnis, `fsync` und einen atomaren Austausch. Solange die Prüfung fehlschlägt, bleibt die bisherige APK erhalten; bereits laufende Downloads können ihre geöffnete Datei zu Ende lesen. Vor einem produktiven Austausch sind die bisherige APK und ihre Prüfsumme unabhängig zu sichern und der Rückweg vorzubereiten: Der Installer erstellt selbst keine Sicherung. Ein Fehler **nach** dem Austausch kann nicht automatisch zurückgerollt werden und wird ausdrücklich als unbestätigtes Ergebnis gemeldet. Die Übergabe und Überprüfung des Hashes muss selbst vertrauenswürdig sein; der Installer prüft keine Android-Signatur und keine Git-Identität.

Diese beiden Werkzeuge sind **noch keine automatische Veröffentlichung**. Weder wird ein Scheduler eingerichtet noch wird das Artefakt automatisch zum Server übertragen. Auch ein beim Build aktueller Commit kann zwischen Prüfung und späterer Veröffentlichung überholt werden. Für einen dauerhaften automatischen Ablauf fehlen unter anderem ein isolierter Build-Checkout mit kontrolliertem Update von `main`, geschützte und beständige Signaturschlüssel, eine zugriffsbeschränkte authentifizierte Übertragung, erneute Git-/Versionsprüfung unmittelbar vor der Übernahme, Speichergrenzen, Überwachung, Wiederherstellung und ein getesteter Umgang mit parallelen oder veralteten Läufen. Erst nach Einrichtung und Ende-zu-Ende-Prüfung dieser Teile kann der Header verlässlich die jeweils neueste Version anbieten.
