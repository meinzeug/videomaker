# Videomaker: Architektur der Agenturplattform

Videomaker ist das Hauptprojekt. Das getrennte Android-Projekt KontraPrompter unter `~/kontraprompter` ist Teil desselben Systems; die Projektbeziehung und Mitentwicklung sind in `AGENTS.md` festgehalten. Das Studio läuft unter `https://videomaker.dorfspy.de`. Der produktive Dienst verwendet `/opt/videomaker`; SQLite und Aufnahmedateien liegen separat unter `/var/lib/videomaker`. Zugangsdaten liegen in der Serverkonfiguration und gehören nicht ins Repository.

## Aktuelle Daten und Verbindungen

- Skripte (`projects`) und ihre Aufnahmen (`project_recordings` und Dateien unter `recordings/`) gehören dem Videomaker. KontraPrompter lädt nach HTTPS-Anmeldung Skripte und öffnet eine lokale Kopie; Änderungen an dieser Kopie werden nicht zurückgeschrieben.
- Kanäle werden einer Plattform und optional einer Kennung zugeordnet. `project_channels` verknüpft ein Skript mit beliebig vielen Kanälen. Das ist eine redaktionelle Zuordnung; es verknüpft noch keine YouTube-, TikTok- oder anderen Plattformkonten.
- Der Teleprompter im Browser kann angemeldeten Android-Anzeigegeräten kurzlebige Befehle senden. Die App meldet sich nur bei aktivierter Fernsteuerung im Vordergrund, bestätigt ausgeführte Befehle und verwendet für jede Aktivierung eine neue Geräteidentität. Die Auswahlliste zeigt nur Geräte mit frischer Statusmeldung. Die Befehle sind kein Ersatz für eine Überwachung der tatsächlichen Kameraaufnahme.
- Die lokale Kamera-Vorschau zwischen Android-Geräten verwendet eine separat bestätigte LAN-Sitzung und WebRTC. Die Web-Fernsteuerung der Anzeige kann parallel dazu laufen. Dashboard-Kameravorschau, Fernsteuerung des Kamerageräts, gleichzeitige Video-/Tonaufnahme und Upload vom Smartphone sind noch nicht implementiert.
- Der Browser kann bereits Kamera und Mikrofon aufnehmen und eine fertige Aufnahme einem Skript zuordnen. Aufnahmedateien und Datenbank müssen gemeinsam gesichert werden.

## Weiterentwicklung

Die Zielrichtung ist eine KI-gestützte Medienagentur-Plattform: Themen und Skripte kanalübergreifend vorbereiten, am Teleprompter aufnehmen, Material bearbeiten und fertige Videos zur Entscheidung und zum Download bereitstellen. Automatisierungsschritte müssen reale Ergebnisse und Fehler zeigen. Entwürfe, bestehende Aufnahmen und Originalbelege dürfen nicht durch Zwischenschritte verloren gehen.

Der Videoeditor wird schrittweise ausgebaut. Ein einfacher Schnitt eines vorhandenen Clips ersetzt weder einen Mehrspur-Editor noch automatischen KI-Schnitt. Für die Smartphone-Kamera ist insbesondere eine gemeinsame Nutzung der Kamera für Vorschau und zuverlässige lokale Aufnahme, die Behandlung von Ton, Unterbrechungen und ein überprüfbarer Upload erforderlich.

Die bisherige Finanz- und Journal-Eigenentwicklung wird durch eine integrierte Buchhaltung ersetzt. Ihre Datenhaltung und der sichere Übergang vorhandener Bestände müssen vor der Inbetriebnahme geprüft werden; bis dahin sind Finanz- und Journalansichten dieser früheren Implementierung nicht verfügbar.

Neue Unterprojekte und gemeinsame Schnittstellen gehören in die Projektanweisungen. Bei Änderungen an gemeinsamen Abläufen beide Repositories und die realen Geräte prüfen; vor einem Produktivwechsel Daten sichern, einen Rückweg vorhalten und die Erreichbarkeit danach kontrollieren.
