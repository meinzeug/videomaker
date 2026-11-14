# Kontrakurs Studio

Geschütztes Dashboard für Webrecherche, YouTube-Skripte und Teleprompter. Next.js, SQLite und OpenRouter; die Suche verwendet das OpenRouter-Servertool `openrouter:web_search` ohne feste Domainliste. Das Modell kann mehrere Suchanfragen durchführen. Recherchierte Links und Veröffentlichungsdaten müssen vor der Veröffentlichung redaktionell überprüft werden. Suchergebnisse sind durch die jeweilige Suchmaschine und deren Index begrenzt.

## Einrichtung

Node.js 22 oder neuer wird empfohlen. `.env.example` nach `.env` kopieren und `OPENROUTER_API_KEY`, `ADMIN_PASSWORD` und ein zufälliges `SESSION_SECRET` (mindestens 32 Zeichen) setzen. Die Datei darf nicht in Git gelangen. `npm ci`, anschließend `npm run dev`; im Browser `http://localhost:3000` öffnen. Der Betrieb unter HTTPS ist für den sicheren Session-Cookie erforderlich (lokale Entwicklung ausgenommen).

Für die vollständige Prüfung des Browser-Origins `VIDEOMAKER_PUBLIC_ORIGIN` auf den **einen tatsächlich verwendeten externen Origin** setzen, zum Beispiel `https://videomaker.dorfspy.de` oder lokal `http://localhost:3000` (ohne Pfad oder abschließenden Schrägstrich). Der Reverse Proxy muss den externen `Host` unverändert weitergeben; `X-Forwarded-Host` und `X-Forwarded-Proto` werden in diesem Modus nicht als Vertrauensanker verwendet. Schema, Host und Port müssen sowohl zum eingehenden `Origin` als auch zum `Host` passen. Ein leerer oder ungültiger konfigurierter Wert sperrt schreibende Anfragen. Ohne diese Variable bleibt aus Kompatibilität mit bestehenden Installationen die frühere rein hostbezogene Prüfung aktiv; diese prüft das Schema nicht vollständig. Vor Aktivierung alle verwendeten Domains und lokalen Testproxies prüfen: Ein einzelner konfigurierter Origin erlaubt keine weiteren alternativen Hosts, und die Android-App verwendet derzeit `https://videomaker.dorfspy.de`.

Standardmodell ist `openai/gpt-6.1-terra` mit `reasoning.effort=xhigh` und verpflichtender Provider-Unterstützung. Recherche und Skriptgenerierung rufen kostenpflichtige OpenRouter- und ggf. Such- bzw. Abrufdienste auf. Die Antwortdauer kann mehrere Minuten betragen. Das App-Passwort und der Session-Schlüssel sind Konfigurationswerte; bei Änderung des Session-Schlüssels werden bestehende Sitzungen ungültig.

## Kanäle und Plattformen

Unter „Kanäle“ können mehrere Kanäle mit Plattform und optionaler Kennung angelegt werden. Neben den vorgegebenen Plattformen können weitere namentlich eingegeben werden. In einer Skriptansicht lässt sich das Skript einem oder mehreren Kanälen zuordnen; vorhandene Skripte bleiben zunächst ohne Zuordnung. Die Zuordnung verbindet noch keine Plattformkonten und veröffentlicht keine Inhalte. Die Android-App KontraPrompter kann nach Anmeldung Skripte aus dem Studio abrufen und als lokale Kopie für den Teleprompter öffnen.

## Videoeditor

Der Videoeditor kann aus einer gespeicherten Aufnahme einen Ausschnitt zwischen 0,1 Sekunden und zehn Minuten als neue MP4-Datei beim selben Skript speichern. Das Original bleibt erhalten; eine vorhandene Audiospur wird übernommen. Auf dem Server müssen `ffmpeg`, `ffprobe` und `flock` sowie die Encoder `libx264` und AAC verfügbar sein. Die Bearbeitung wird auf einen Auftrag gleichzeitig begrenzt und kann einige Minuten dauern. Mehrspur- und KI-Schnitt sind noch nicht implementiert.

## Buchhaltung

Die bisherige Finanz- und Journal-Eigenentwicklung wird entfernt. Die Integration der Buchhaltung befindet sich im Umbau; bis zur abgeschlossenen Einrichtung ist sie in dieser Version noch nicht verfügbar. Die vorbereitete und nicht automatisch ausgeführte Bereinigung der alten Datenbanktabellen ist in [docs/remove-legacy-finance.md](docs/remove-legacy-finance.md) beschrieben.

## DNS und Deployment

`scripts/setup-dns.sh` liest `~/hetznerkey.txt` bzw. `$HETZNER_KEY_FILE` und legt den A-Record über die Hetzner Cloud API an. Ein vorhandener abweichender A-Record wird nicht überschrieben.

`scripts/deploy.sh` synchronisiert das Projekt per SSH nach `dorfspy`, baut es dort und installiert einen eigenen systemd-Dienst auf `127.0.0.1:3270`. Es ergänzt den vorhandenen Caddy um einen separaten Host und validiert die Konfiguration vor dem Reload. Caddy verwaltet das HTTPS-Zertifikat. Die persistenten SQLite-Daten liegen unter `/var/lib/videomaker`, die Server-Konfiguration unter `/etc/videomaker.env`. Die Quelldateien werden unter `/opt/videomaker` bei jedem Deployment ersetzt; benachbarte Dienste und Daten werden nicht synchronisiert. Die lokale `.env` wird dabei sicher auf den Server übertragen.

Alternativ kann `docker compose up -d --build` die App auf `127.0.0.1:3270` starten; dafür wird ein vorhandener Reverse Proxy benötigt. `deploy/nginx.conf` ist ein Beispiel für einen separaten Nginx-Host mit bereits eingerichtetem Let's-Encrypt-Zertifikat. Auf dem bestehenden Zielserver werden systemd und Caddy verwendet, damit keine anderen Websites ihre Ports verlieren.

Teleprompter: Skript öffnen, anschließend „Teleprompter öffnen“. Die Leertaste startet und pausiert den Lauf, sofern kein Eingabefeld oder Button fokussiert ist. Im manuellen Modus verringern beziehungsweise erhöhen die Pfeiltasten links und rechts das Tempo in Fünferschritten, auch während des Laufens. Eingabefelder behalten ihre normale Tastaturbedienung. Tempo, Schriftgröße und Spiegelung sind während der Aufnahme einstellbar.

Im Teleprompter-Bereich kann ein Android-Anzeigegerät nach Anmeldung in KontraPrompter und expliziter Aktivierung der Fernsteuerung ausgewählt werden. Das aktuelle Skript sowie Start, Pause und Anfang lassen sich an das geöffnete Gerät senden. Geräte verschwinden nach ausbleibenden Statusmeldungen aus der Auswahl; nicht bestätigte Befehle verfallen nach kurzer Zeit. Die Fernsteuerung läuft nur im Vordergrund. Das Kamera-Smartphone kann inzwischen lokal mit Ton aufnehmen und ein Video nach ausdrücklicher Skriptauswahl und Anmeldung manuell zu Videomaker hochladen. Aufnahmefernsteuerung und Kamerabild im Web sind noch nicht implementiert.

Im Teleprompter kann zwischen „Manuell“ und „Sprache“ gewechselt werden. Im Sprachmodus wird der erkannte Text mit dem Skript abgeglichen; das aktuelle Wort wird markiert und der Text folgt der Stimme. Bei Sprechpausen bleibt er stehen. Start/Pause und der Wechsel zurück zum manuellen Tempo bleiben verfügbar. Beim Aufnahmestart wird die Sprachsteuerung mitgestartet, sofern sie ausgewählt ist. Wo der Browser es unterstützt, nutzt die Erkennung dieselbe Mikrofonquelle wie die Aufnahme; andernfalls kann der Browser einen eigenen Mikrofonzugriff anfordern. Die Browser-Spracherkennung ist nicht überall verfügbar und kann Audio über einen externen Erkennungsdienst verarbeiten. Bei einem Fehler pausiert nur der Textlauf, nicht die Videoaufnahme. Versprecher, Hintergrundgeräusche und Verbindungsprobleme können die Erkennung beeinträchtigen.

## Bilder und Thumbnail

Beim Start der Skripterstellung wird ausgewählt, ob Bilder erzeugt oder nur Bildbeschreibungen erstellt werden sollen. GPT-6.1 Sol plant anhand des vollständigen Skripts in beiden Fällen eine variable Anzahl von zwei bis sechs passenden Einblendbildern und ein Thumbnail. Im Textmodus werden deutsche Beschreibungen, Einsatzstellen und englische Bildprompts gespeichert, ohne den Bildrenderer aufzurufen; die Bilder können später manuell erstellt werden. Jedes Motiv wird separat als Querformat für YouTube (16:9) und Hochformat für TikTok (9:16) generiert. Die Thumbnails erhalten in beiden Formaten dasselbe feste Layout in Schwarz, Rot und Weiß. Die Bilddateien rendert standardmäßig `microsoft/mai-image-2.6-flash` über OpenRouter; Terra und Sol geben selbst Text aus. Der Renderer ist über `IMAGE_MODEL`, die Bildplanung über `IMAGE_PLANNER_MODEL` konfigurierbar. Die bestehenden OpenRouter-Datenschutzeinstellungen gelten unverändert. Bildgenerierung verursacht zusätzliche Kosten.

Die Bilder werden im Hintergrund erzeugt und zusammen mit ihrem Fortschritt in SQLite gespeichert. In der Skriptansicht können sie einzeln heruntergeladen werden. Bei Fehlern oder nach einem Serverneustart kann die Erstellung fehlender Bilder erneut gestartet werden; fertige Bilder bleiben erhalten. Für ältere Skripte startet der Button „Bilder erstellen“ die Nachgenerierung. Wird ein Skript gelöscht, werden auch seine Bilder entfernt.

## Vertiefte Recherche vor dem Skript

Jedes neue Skript setzt eine separate Webrecherche voraus. Bei vorübergehenden Dienstfehlern werden Recherche und Skripterstellung jeweils bis zu zweimal automatisch wiederholt; die bereits abgeschlossene Recherche bleibt dabei erhalten. Das Modell sucht zu den Ausgangsmeldungen mehrfach im Web, prüft Gegenpositionen und soll nach Möglichkeit Primärquellen abrufen. Der gespeicherte Recherchebericht zeigt Quellen, Befunde, offene Fragen und gegebenenfalls ausdrücklich gekennzeichnete Hypothesen mit Anhaltspunkten und Alternativen. Er ist eine KI-Arbeitshilfe und ersetzt keine redaktionelle Prüfung. Vorwürfe über Absicht oder geheime Absprachen dürfen nicht allein aus einem Widerspruch abgeleitet werden.

Für die Video-Dramaturgie dienen unter anderem YouTubes Hinweise zu [Einstieg, Titelversprechen und Zuschauerbindung](https://support.google.com/youtube/answer/9314415) sowie die [journalistischen Standards von Reuters](https://reutersagency.com/about/standards-values/) als Orientierung.

Neue Skripte beginnen mit einem kurzen Einstieg und begrüßen danach die Zuschauer. Am Ende folgen eine kurze Verabschiedung und ein Aufruf zum Liken, Abonnieren und Kommentieren.

## Videoaufnahme im Teleprompter

Im Teleprompter lassen sich nach ausdrücklicher Browserfreigabe Kamera und Mikrofon vorbereiten. „Aufnahme starten“ startet zugleich den Textlauf; Play/Pause und Tempo bleiben unabhängig bedienbar. Nach dem Stoppen kann das Video direkt kontrolliert und als MP4 oder WebM heruntergeladen werden, abhängig vom Browser. Die Vorschau ist stumm, die Aufnahme enthält den Mikrofonton. Der Browserzugriff benötigt HTTPS und ein angeschlossenes, freigegebenes Kamera- und Mikrofongerät.

Nach dem Stoppen wird die Aufnahme automatisch dem geöffneten Skript zugeordnet und auf den Server hochgeladen. Der Fortschritt wird angezeigt; bei einem Fehler kann der Upload wiederholt oder die Aufnahme lokal heruntergeladen werden. Erst nach Abschluss des Uploads steht sie dauerhaft in der Skriptansicht unter „Deine Aufnahmen“ zur Wiedergabe und zum Download bereit. Pro Skript sind mehrere Aufnahmen möglich; einzelne Aufnahmen können dort gelöscht werden. Beim Löschen eines Skripts werden auch seine Aufnahmen entfernt.

Die Videodateien liegen im persistenten Datenverzeichnis unter `recordings/`, die Zuordnung in SQLite. Backups müssen beide enthalten. Pro Aufnahme sind maximal 1 GiB zulässig, und während der Aufnahme benötigt der Browser ausreichend Arbeitsspeicher. Langfristig begrenzt der verfügbare Server-Speicherplatz die Anzahl der Aufnahmen.

## News-Pakete

Erfolgreiche News-Recherchen werden dauerhaft gespeichert und können über den Menüpunkt „News-Pakete“ später erneut geöffnet und zur Skripterstellung verwendet werden. Auf der Übersicht und im Archiv kann über das Eingabefeld auch ein eigenes Thema recherchiert werden; dabei sind für Hintergrundinformationen ältere Quellen zulässig. Das Archiv enthält die Quellen und das Recherche-Datum; ältere Meldungen sollten vor der Verwendung erneut auf Aktualität geprüft werden. Pakete, die vor Einführung des Archivs nur im Browser angezeigt wurden, konnten nicht rückwirkend übernommen werden.

News-Pakete können auch über „News-Paket manuell anlegen“ mit oder ohne Quellenlinks gespeichert werden. Bis zu drei HTTPS-Artikellinks lassen sich mit Titel, Medium, Datum und Zusammenfassung hinterlegen. Beim Start der KI-Skripterstellung wird auch ohne hinterlegte Links zum Thema recherchiert. Über die Symbole am Paket lassen sich sowohl manuelle als auch recherchierte Pakete bearbeiten oder löschen.

Unter „Meine Skripte“ legt „Skript manuell anlegen“ ein eigenes Skript an. Der Text kann eingefügt oder aus einer Textdatei geladen werden; Quellen, alternative Titel, Thumbnail- und Bildideen sind optional. Das Speichern verändert den selbst geschriebenen Text nicht und startet keine KI. In der Skriptansicht können manuelle und KI-erstellte Skripte bearbeitet werden. Bilder, Aufnahmen und der ursprüngliche Recherchebericht bleiben dabei erhalten und können nach Änderungen inhaltlich vom Skript abweichen.
