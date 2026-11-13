# Kontrakurs Studio

Geschütztes Dashboard für Webrecherche, YouTube-Skripte und Teleprompter. Next.js, SQLite und OpenRouter; die Suche verwendet das OpenRouter-Servertool `openrouter:web_search` ohne feste Domainliste. Das Modell kann mehrere Suchanfragen durchführen. Recherchierte Links und Veröffentlichungsdaten müssen vor der Veröffentlichung redaktionell überprüft werden. Suchergebnisse sind durch die jeweilige Suchmaschine und deren Index begrenzt.

## Einrichtung

Node.js 22 oder neuer wird empfohlen. `.env.example` nach `.env` kopieren und `OPENROUTER_API_KEY`, `ADMIN_PASSWORD` und ein zufälliges `SESSION_SECRET` (mindestens 32 Zeichen) setzen. Die Datei darf nicht in Git gelangen. `npm ci`, anschließend `npm run dev`; im Browser `http://localhost:3000` öffnen. Der Betrieb unter HTTPS ist für den sicheren Session-Cookie erforderlich (lokale Entwicklung ausgenommen).

Standardmodell ist `openai/gpt-6.1-terra` mit `reasoning.effort=xhigh` und verpflichtender Provider-Unterstützung. Recherche und Skriptgenerierung rufen kostenpflichtige OpenRouter- und ggf. Such- bzw. Abrufdienste auf. Die Antwortdauer kann mehrere Minuten betragen. Das App-Passwort und der Session-Schlüssel sind Konfigurationswerte; bei Änderung des Session-Schlüssels werden bestehende Sitzungen ungültig.

## DNS und Deployment

`scripts/setup-dns.sh` liest `~/hetznerkey.txt` bzw. `$HETZNER_KEY_FILE` und legt den A-Record über die Hetzner Cloud API an. Ein vorhandener abweichender A-Record wird nicht überschrieben.

`scripts/deploy.sh` synchronisiert das Projekt per SSH nach `dorfspy`, baut es dort und installiert einen eigenen systemd-Dienst auf `127.0.0.1:3270`. Es ergänzt den vorhandenen Caddy um einen separaten Host und validiert die Konfiguration vor dem Reload. Caddy verwaltet das HTTPS-Zertifikat. Die persistenten SQLite-Daten liegen unter `/var/lib/videomaker`, die Server-Konfiguration unter `/etc/videomaker.env`. Die Quelldateien werden unter `/opt/videomaker` bei jedem Deployment ersetzt; benachbarte Dienste und Daten werden nicht synchronisiert. Die lokale `.env` wird dabei sicher auf den Server übertragen.

Alternativ kann `docker compose up -d --build` die App auf `127.0.0.1:3270` starten; dafür wird ein vorhandener Reverse Proxy benötigt. `deploy/nginx.conf` ist ein Beispiel für einen separaten Nginx-Host mit bereits eingerichtetem Let's-Encrypt-Zertifikat. Auf dem bestehenden Zielserver werden systemd und Caddy verwendet, damit keine anderen Websites ihre Ports verlieren.

Teleprompter: Skript öffnen, anschließend „Teleprompter öffnen“. Die Leertaste startet und pausiert den Lauf, sofern kein Eingabefeld oder Button fokussiert ist. Tempo, Schriftgröße und Spiegelung sind während der Aufnahme einstellbar.

## Bilder und Thumbnail

Nach der Skripterstellung plant GPT-6.1 Sol anhand des vollständigen Skripts eine variable Anzahl von zwei bis sechs passenden Einblendbildern. Jedes Motiv wird separat als Querformat für YouTube (16:9) und Hochformat für TikTok (9:16) generiert. Die Thumbnails erhalten in beiden Formaten dasselbe feste Layout in Schwarz, Rot und Weiß. Die Bilddateien rendert standardmäßig `microsoft/mai-image-2.6-flash` über OpenRouter; Terra und Sol geben selbst Text aus. Der Renderer ist über `IMAGE_MODEL`, die Bildplanung über `IMAGE_PLANNER_MODEL` konfigurierbar. Die bestehenden OpenRouter-Datenschutzeinstellungen gelten unverändert. Bildgenerierung verursacht zusätzliche Kosten.

Die Bilder werden im Hintergrund erzeugt und zusammen mit ihrem Fortschritt in SQLite gespeichert. In der Skriptansicht können sie einzeln heruntergeladen werden. Bei Fehlern oder nach einem Serverneustart kann die Erstellung fehlender Bilder erneut gestartet werden; fertige Bilder bleiben erhalten. Für ältere Skripte startet der Button „Bilder erstellen“ die Nachgenerierung. Wird ein Skript gelöscht, werden auch seine Bilder entfernt.

## Vertiefte Recherche vor dem Skript

Jedes neue Skript setzt eine separate Webrecherche voraus. Das Modell sucht zu den Ausgangsmeldungen mehrfach im Web, prüft Gegenpositionen und soll nach Möglichkeit Primärquellen abrufen. Der gespeicherte Recherchebericht zeigt Quellen, Befunde, offene Fragen und gegebenenfalls ausdrücklich gekennzeichnete Hypothesen mit Anhaltspunkten und Alternativen. Er ist eine KI-Arbeitshilfe und ersetzt keine redaktionelle Prüfung. Vorwürfe über Absicht oder geheime Absprachen dürfen nicht allein aus einem Widerspruch abgeleitet werden.

Für die Video-Dramaturgie dienen unter anderem YouTubes Hinweise zu [Einstieg, Titelversprechen und Zuschauerbindung](https://support.google.com/youtube/answer/9314415) sowie die [journalistischen Standards von Reuters](https://reutersagency.com/about/standards-values/) als Orientierung.
