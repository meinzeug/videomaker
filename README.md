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
