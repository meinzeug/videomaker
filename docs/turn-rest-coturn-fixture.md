# TURN-REST-Integrationstest

`scripts/test-turn-rest-coturn.py` prüft den Credential-Kern gegen eine eigene, kurzlebige coturn-Instanz auf `127.0.0.1`. Voraussetzungen sind Python 3, Node mit `--experimental-strip-types` und das coturn-Paket mit `turnserver` und `turnutils_uclient`.

```sh
python3 scripts/test-turn-rest-coturn.py
```

Das Skript erzeugt ein zufälliges Testgeheimnis und eine private temporäre Konfiguration, startet weder einen systemd-Dienst noch einen öffentlichen Listener und entfernt den Testserver und die Dateien beim regulären Beenden. Zwei coturn-Testclients tauschen UDP-Pakete mit Credentials aus dem echten TypeScript-Kern; ungültige und abgelaufene Credentials müssen abgewiesen werden. Das Testwerkzeug benötigt mehrere Allocations; die Fixture-Quoten sind daher keine Empfehlung für den Produktivbetrieb. Wie bei Kommandozeilen-Testprogrammen üblich, können die kurzlebigen **Test**-Credentials während des Tests in der lokalen Prozessliste sichtbar sein. Niemals produktive Zugangsdaten einsetzen.

Dieser Test nutzt absichtlich `allow-loopback-peers` und deaktiviertes TLS nur in der Loopback-Fixture. Er belegt weder Geräteidentität noch einen sicheren Signalisierungskanal, TLS, TURN-Refresh/Erneuerung bei langen Sessions, öffentliche Firewall-Freigaben oder Ende-zu-Ende-WebRTC auf Smartphones. Eine produktive Ausgabe oder ein öffentlich erreichbarer Relay bleibt bis zur passenden Authentisierung, Ressourcenbegrenzung und gesonderten Netz-/Geräteprüfung deaktiviert.

## Experimenteller WSS/TCP-Tunnel

```sh
node --experimental-strip-types --test tests/fixtures/turn-wss-loopback.test.mjs
```

Die zweite Fixture benötigt zusätzlich `openssl` und die im Lockfile installierten Next.js-Abhängigkeiten. Sie erzeugt ein kurzlebiges selbstsigniertes Testzertifikat, prüft es auf der Clientseite und bindet sämtliche Listener ausschließlich an Loopback. Ein zufälliges Test-Bearer-Token schützt das WebSocket-Upgrade. Es werden falsches Token, nicht vertrauenswürdiges Zertifikat, Verbindungslimit, Textframes, übergroße Frames, Gesamtbytes, Idle-Ende und Rückstau mit anschließendem Fortsetzen geprüft. Abschließend tauschen echte coturn-Testclients TURN/TCP-Nutzdaten über zwei lokale TLS/WebSocket-/TCP-Proxys aus. Bei regulärem Ende werden Testserver und temporäre Schlüsseldateien beendet bzw. entfernt.

Die Bridge liegt isoliert unter `experiments/turn-wss/bridge.mjs` und verweigert den Start, sofern nicht ausdrücklich Testmodus und Fixture-Flag gesetzt sind; in `NODE_ENV=production` bleibt sie gesperrt. Sie verwendet die öffentliche `createWebSocketStream`-Schnittstelle und Node-Streams für Rückstau, keinen direkten Zugriff auf `_socket`. Die Fixture setzt WebSocket-Maximalgröße und deaktivierte Kompression bereits vor dem Upgrade und begrenzt zusätzlich Gesamtdaten, Leerlauf und Sitzungsdauer. Die kurzen Limits sind ausschließlich Testwerte, keine Vorgaben für eine Videoaufnahme. Die Streams schließen bei Abbruch beide Seiten und erlauben einen expliziten Abbruch per Signal.

Die zufällige Test-Bearerprüfung ist **keine** Geräte- oder Paarungsbindung; die Bridge stellt selbst keinen HTTP-Endpunkt bereit. Geräteauthentisierung und deren Widerruf/Fencing, gemeinsame und gerätespezifische Quoten über Prozesse hinweg, sichere Zertifikatsbereitstellung, echter WSS-Zugang über die Domain sowie Android-Anbindung bleiben offen. Damit ist der Prototyp nicht produktionsreif. Die Fixture beweist weder WebRTC- noch Bild-/Ton-Funktion auf den Smartphones.
