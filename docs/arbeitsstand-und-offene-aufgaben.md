# Arbeitsstand und offene Aufgaben

Stand: 15. November 2026. Diese Übergabe beschreibt beobachtete Zustände, keine dauerhafte Garantie. Vor Fortsetzung Git- und Dienststatus erneut prüfen. Keine Zugangsdaten, Sitzungscodes oder API-Schlüssel in diesem Dokument ablegen.

## Projekt und Schutz vorhandener Arbeit

- Videomaker ist das Hauptrepository (`~/videomaker`, `meinzeug/videomaker`, produktiv `https://videomaker.dorfspy.de`); KontraPrompter ist die verbundene Android-Untersoftware (`~/kontraprompter`, `meinzeug/kontraprompter`). Bei gemeinsamen Schnittstellen und Releases beide Repositories und Geräte gemeinsam prüfen.
- Die Android-Gestaltungsreferenz ist `~/kontraprompter/SKILL.md`. Vorhandene Aufnahmen, Konten, Datenbanken, Serverkonfiguration sowie nicht eingecheckte Arbeit schützen. Vor Produktivwechsel Backup, geprüften Rückweg und anschließenden Funktionstest vorbereiten.
- Der lokale Videomaker-Hauptcheckout hatte beim Erstellen dieser Übergabe zahlreiche bestehende, nicht eingecheckte Änderungen, darunter Finanz-/Haben-Arbeit. Er war hinter `origin/main`; nicht zurücksetzen, bereinigen oder pauschal überschreiben. Für isolierte Arbeiten saubere Git-Worktrees verwenden und tatsächliche Konflikte sorgfältig prüfen. Android hatte ein unversioniertes `SKILL.md`; dieses erhalten.

## Höchste Priorität: Produktion mit zwei Smartphones

- Auf Android-`main` wurde der Wi‑Fi-Direct-/WebRTC-Fix mit Commit `98f0387` integriert. Das normale WLAN erlaubte bei diesem Test keine direkte Verbindung zwischen den Telefonen; eine konkrete Routerursache ist nicht bewiesen. Wi‑Fi Direct wurde manuell über Android eingerichtet, beide Geräte blieben gleichzeitig im Internet-WLAN.
- Praxisnachweis: Xiaomi als Kamera, Samsung als Teleprompter; tatsächliche Liveframes, Fernstart, Pause, Fortsetzen und Stopp sowie lokal gespeichertes, dekodierbares Video und Audio funktionierten. Der selektive Hauptzweig-Kandidat bestand seinen separaten Geräte- und CI-Test. Erkenntnisse und Grenzen stehen auch im Android-Repository in `docs/p2p-bound-ice-wip.md` und `docs/paired-start-disconnect-fence-wip.md`; der isolierte Gerätebericht liegt im WIP `wip/p2p-device-evidence-9781bc2-20261115`.
- Die Direktverbindung wird noch über Systemeinstellungen und manuelle Kamera-P2P-Adresse eingerichtet. Automatische Einrichtung/Wiederverbindung und das Verhalten bei Netzwechsel, unbekannten Geräte-Interfaces, Offline-WLAN, VPN und älteren App-Versionen sind nicht umfassend nachgewiesen. Kein funktionierendes WLAN- oder Webdashboard-Verhalten als bereits geprüft ausgeben, wenn es nur eine synthetische Fixture abdeckte.
- Die neu gestaltete Android-Oberfläche und der Netzwerkfix wurden als Mergecommit `2a6983e` auf Android-`main` integriert. Der Appcode entspricht dem auf beiden Geräten getesteten `9781bc2`; der zusätzliche Main-Test blieb erhalten. Debug-, Unit-, Release-Build und Lint des Integrationsstands bestanden. Weitere Prüfungen aller Seiten, TalkBack/große Schrift, Netzwechsel sowie der nicht-debuggbaren Release-APK bleiben gesondert notwendig; `SKILL.md` und bestehende Aufnahme-/Pairingfunktionen beachten.
- Der produktive APK-Download lieferte bei dieser Übergabe noch eine ältere APK (`/var/lib/videomaker/kontraprompter.apk`, SHA-256 beginnt `13df4c5d`). Eine getestete Debug-APK auf den Telefonen ist keine veröffentlichte Release-APK. Nicht-debuggable, signaturkompatiblen Release-Build erzeugen, auf beiden Geräten samt P2P-/Aufnahmetest prüfen, Quelle/Signatur/Hash dokumentieren und erst danach den Download mit Backup und geprüftem Rückweg austauschen. Das vorhandene ältere Recovery-Skript ist an frühere Hashes gebunden und muss für einen neuen Austausch neu geprüft werden.

## Webdashboard und Kamerafernsteuerung

- Der produktive Videomaker-Webstand enthielt den Fix für abgelaufene Sitzungen und Skriptvorgaben (Web-`main` bei Übergabe `3d22c909`). Die Teleprompter-Gerätesteuerung für Skript laden, Start/Pause/Anfang, Tempo und Schrift ist im Code vorhanden und erscheint nach Skriptauswahl; deren echten produktiven Ende-zu-Ende-Zustand gesondert prüfen.
- Web-Kamerafernsteuerung und Browservorschau sind produktiv gesperrt. Nicht einfach Flags öffnen: aktueller Web-/Android-main hat unterschiedliche Kameravertragsstände; das v4-WIP enthält Fortschritte, aber das Panel hatte zuletzt nur Start/Stopp. Web und Android gemeinsam auf aktuelle main-Stände portieren; Panel für Start, Pause, Fortsetzen, Stopp und Kamerawechsel ergänzen, tatsächliche Geräte-/Projektzustände und Unsicherheit verständlich anzeigen.
- Für Kamera-v4 sind separate WIPs vorhanden: Web `88b2d84` und Android `6ad6470` als historische Ausgangspunkte. Laufende Portierungen können neuere Stände haben; Git und CI prüfen. Isolierte Tests mit synthetischen Recorderereignissen sind kein Nachweis für eine echte Webaufnahme. Vor Freigabe den vollständigen Ablauf mit echten Geräten, Recorder, Aufnahme, Cloud-Upload und Fehler-/Wiederanlaufszenarien auf getrenntem Staging verifizieren; bestehende Projekt- und Aufnahmedaten schützen.
- Ungeklärte Start-/Stoppbefehle, Idempotenz, Schlüsselverlust/Wiederherstellung, begrenzte Aufbewahrung und Quoten sowie Logout-/Vorschau-Abbruch sind noch offene Arbeit. Browservideo unabhängig von reiner Fernbedienung behandeln und erst freigeben, wenn sein tatsächlicher Medienabbruch geprüft ist. Dokumente `docs/camera-production-readiness.md`, `docs/camera-remote-protocol.md` und Android-WIP-Dokumentation zu Rate ziehen; dortige historische Aussagen gegen den aktuellen Code prüfen.

## Skripterstellung

- Kontrakurs ist kanalgebundenes Preset; andere Kanäle behalten eigene Vorgaben. Grok soll Länge und Aufbau frei wählen und explizit gewählte Tonarten beachten; „Quellen umformulieren ohne eigene Bewertung“ bleibt wählbar. API-Schlüssel ausschließlich serverseitig über Umgebung.
- Ein einzelner echter Grok-Test zeigte den gewählten frechen/arroganten Ton, ergänzte aber unbelegte Details. Der Workflow prüft u. a. Zitate und Quellen, erkennt jedoch nicht jede unbelegte sinngemäße Behauptung im fertigen Text. Faktentreue nicht als automatisch garantiert darstellen; Prüfung und Verbesserung des Gesamtworkflows weiterführen.

## Spätere Agenturmodule

- Nach funktionsfähiger Produktion und Fernbedienung die Gesamtplattform weiterentwickeln: kanal- und plattformübergreifende Medienverwaltung, KI-gestützte Planung/Skripte und Schnitt sowie Videoeditor. Fortschritt nachweisbar und in kleinen integrierten Schritten liefern.
- Haben soll laut Nutzer als aktualisierbare, nahtlose Buchhaltung für eine deutsche UG und Medienagentur integriert werden; frühere Finanz-/Journalimplementierung soll entfallen. Für diese Arbeit hatte der Nutzer ausdrücklich eine Pause zugunsten von KontraPrompter angeordnet. Alte Finanzdaten müssen nicht übernommen werden. Finanz-/Haben-Änderungen im schmutzigen Hauptcheckout sind vorhandene Arbeit und dürfen nicht verloren gehen. Diese Aufgabe erst nach der vorrangigen Smartphone-/Dashboard-Arbeit wieder aufnehmen und aktuellen Auftrag beachten.

## Übergaberegel

Bei jeder Fortsetzung zuerst aktuellen Stand in beiden Git-Repositories, verfügbare Geräte, CI und produktive Version lesen; keine historischen Commit- oder Testaussagen ungeprüft als aktuellen Zustand ausgeben. Fertige, geprüfte Schritte in `main` integrieren und sicher deployen; unvollständige oder nur synthetisch getestete Funktionen klar kennzeichnen. Diese Datei nach wesentlichen Fortschritten aktualisieren.

### Gesicherte Zwischenstände vom selben Tag

Diese Stände sind nicht automatisch produktiv und können bei späterer Fortsetzung veraltet sein:

- Android-Oberflächenmerge `2a6983e` ist auf `main`; der Appcode ist mit dem auf beiden Geräten getesteten `9781bc2` identisch, zusätzlich ist ein Main-Test erhalten. CI-Run `43727725057` bestand Debug-/Release-Build, Unit-Tests und Lint. Vor APK-Veröffentlichung den nicht-debuggbaren Release-Build gesondert auf Geräten prüfen und den aktuellen Serverstand verifizieren.
- Web-v4-Serverkern `5a90b16`, Folgefix `d54486c` auf `wip/camera-v4-web-current-20261115`, Produktionsgate bleibt geschlossen. CI `43727861636` war für `5a90b16` grün; für `d54486c` waren 42 gezielte Tests und Kameratests grün, vollständige CI und HTTP-Fixtures aber noch zu wiederholen. Vor Zusammenführung Branchstatus, Review und Tests prüfen.
- Web-Kamerapanel `0d3aa03` auf `wip/camera-panel-current-20261115`: acht gezielte Tests und TypeScript bestanden; erwartet weitere noch zu integrierende Serverfelder und darf nicht allein freigeschaltet werden.
- Android-v4-Port `0e6f9cb` und Koexistenztests `3165920` auf getrennten WIP-Ständen; die Port-CI `43727417906` war grün. Das belegt keine gemeinsame Web-/P2P-Aufnahmesteuerung. Webbesitz und P2P-Aufnahme schließen sich derzeit aus; Lebenszyklus-/Fehler-STOP muss auf den richtigen Take begrenzt werden.
- Dringende übergreifende Lücke: ein STOP für einen noch unbekannten Take darf einen verspätet ankommenden START nicht unbemerkt zulassen. Das verlangt eine gemeinsame Server-/Android-Strategie einschließlich atomarer Startberechtigung/Fence, Wiederholung, Wiederherstellung und echten integrierten Tests. UI-Timeout oder lokales Abbrechen allein löst es nicht. Kamera-Produktionsgate bis zum belastbaren gemeinsamen Nachweis geschlossen halten.
