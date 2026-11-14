# TURN-REST-Integrationstest

`scripts/test-turn-rest-coturn.py` prüft den Credential-Kern gegen eine eigene, kurzlebige coturn-Instanz auf `127.0.0.1`. Voraussetzungen sind Python 3, Node mit `--experimental-strip-types` und das coturn-Paket mit `turnserver` und `turnutils_uclient`.

```sh
python3 scripts/test-turn-rest-coturn.py
```

Das Skript erzeugt ein zufälliges Testgeheimnis und eine private temporäre Konfiguration, startet weder einen systemd-Dienst noch einen öffentlichen Listener und entfernt den Testserver und die Dateien beim regulären Beenden. Zwei coturn-Testclients tauschen UDP-Pakete mit Credentials aus dem echten TypeScript-Kern; ungültige und abgelaufene Credentials müssen abgewiesen werden. Das Testwerkzeug benötigt mehrere Allocations; die Fixture-Quoten sind daher keine Empfehlung für den Produktivbetrieb. Wie bei Kommandozeilen-Testprogrammen üblich, können die kurzlebigen **Test**-Credentials während des Tests in der lokalen Prozessliste sichtbar sein. Niemals produktive Zugangsdaten einsetzen.

Dieser Test nutzt absichtlich `allow-loopback-peers` und deaktiviertes TLS nur in der Loopback-Fixture. Er belegt weder Geräteidentität noch einen sicheren Signalisierungskanal, TLS, TURN-Refresh/Erneuerung bei langen Sessions, öffentliche Firewall-Freigaben oder Ende-zu-Ende-WebRTC auf Smartphones. Eine produktive Ausgabe oder ein öffentlich erreichbarer Relay bleibt bis zur passenden Authentisierung, Ressourcenbegrenzung und gesonderten Netz-/Geräteprüfung deaktiviert.
