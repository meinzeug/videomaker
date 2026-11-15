# Kameravertrag v4: isolierter Web-Port

Dieser WIP überträgt den Serververtrag aus `88b2d84` auf Webstand `3d22c909`.
Das Kamerapanel wird separat bearbeitet und ist in diesem Port unverändert.
Das Produktionsgate bleibt unverändert: Kamera- und Vorschau-API liefern in
Produktion 404; der Android-Hauptstand hat die Webkamera-Oberfläche deaktiviert.
Dies ist keine Freigabe.

Der Vertrag bindet Zustellung und Quittung an Geräte- und Protokollversion.
Pause und Fortsetzen sind an Aufnahme und das vom Gerät bestätigte Projekt
gebunden; der langlebige STOP an die Aufnahme bleibt auch bei ungeklärtem START
verfügbar. Ein START mit `enqueued` ist nur im Kamera-Executor vorgemerkt,
keine bestätigte Aufnahme oder Cloud-Datei. `uncertain` sperrt neue Befehle,
nicht aber den Stopp einer nachgewiesenen aktiven Aufnahme.

Die Geräteliste gibt `capability` als exakt gemeldeten Wert nur dann aus, wenn
die gespeicherte Meldung zur aktuellen Gerätesequenz passt; andernfalls ist der
Wert `null`. Bei schon vorhandenen Geräten ohne diesen zusätzlichen Nachweis
bleibt er bis zum nächsten gültigen Heartbeat unbekannt. Die bestehende interne
v4-auf-v3-Abbildung für Pause/Fortsetzen bleibt erhalten; sie ist kein Nachweis
für die im UI anzuzeigende Version. Für veraltete Testdatenbanken kann das
bestehende Kamera-Control-Schema eine explizite Migration erfordern; es wird
nicht blind umgeschrieben. Kamerawechsel ist nur bei bestätigtem `idle` möglich.

Gezielte SQLite-/STOP-/Attempt-Tests und eine isolierte v4-HTTP-Fixture mit
eigenem Nutzer, Datenbank, Signaturschlüssel und localhost-Next-Server testen
unter anderem Capability, Projektbindung, gemischte Protokollversionen, ACK,
ungeklärte Entscheidungen und STOP. Die Fixture verändert temporär nur die
Konfiguration dieses Worktrees und stellt sie anschließend wieder her; sie
verwendet keine Produktionsdaten. Die frühere v4-Gerätefixture verwendete
synthetische Recorderereignisse; sie ist kein Nachweis einer echten Aufnahme
für diese Quellkombination.

Vor einer Freigabe fehlen weiterhin ein unabhängiger Integrationsreview und
Ende-zu-Ende-Tests mit dem passenden Android-v4-Stand, echtem Recorder, Web-UI,
Upload und Prozess-/Netzwerkfehlern. Sichere Auflösung ungeklärter Aktionen,
Schlüsselverlust und Backup-Restore, Anti-Downgrade, Archivierung/Quoten und
der getrennte Vorschauwiderruf sind offen. Keine laufende lokale Aufnahme darf
wegen eines Netzabbruchs als beendet angenommen werden. Produktionsflags werden
hier nicht freigeschaltet.

## Nachträgliche Absicherung des Testvertrags

Pause/Fortsetzen benötigen jetzt auch im HTTP-Auftrag die erwartete Projekt-ID.
Sie wird unter dem Writerlock mit Aufnahme, aktuellem Gerätestatus und offenem
Claim verglichen und bei idempotentem Retry erneut gegen die gespeicherte ID
geprüft. Ältere Clients, die diese ID weglassen, werden bewusst abgewiesen.
Das Browserpanel muss denselben Vertrag verwenden.

Ein bereits zugestellter, serverseitig abgelaufener Control-Befehl sperrt neue
Starts und Controls. Eine nachträglich angenommene Entscheidung löst die
Sperre erst nach einem passenden Gerätezustand; diese Beobachtung wird dauerhaft
gespeichert, damit spätere Zustandswechsel sie nicht rückwirkend ungültig machen.
STOP für eine beobachtete Aufnahme bleibt verfügbar. Ein älterer angenommener
Control ohne nachweisbare Zustandsbeobachtung kann deshalb ebenfalls gesperrt
bleiben; ein sicherer Auflösungsweg ist noch nicht implementiert. Das Gerätelisten-
`lastControl.cameraFrom` enthält bei einem Kamerawechsel die gebundene vorherige
Kameraseite, sonst `null`.

Ein vor STOP gestarteter, aber erst später am Server eintreffender START wird
damit nicht widerrufen. Eine versions-/generationsgebundene Startberechtigung,
die bei STOP atomar verfällt, ist ein gesonderter Freigabeblocker. Der bisherige
Startpermit-Baustein ist nicht mit Routen oder dieser Grenze verbunden.
