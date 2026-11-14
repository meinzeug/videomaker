# KontraPrompter: WLAN-Befund, 14.11.2026

## Beobachtungen

- Im Testaufbau ist das Xiaomi die Kamera, das Samsung der Teleprompter. Zuvor war die direkte Verbindung zeitweise gestört: Auf dem Samsung wurde der IPv4-Nachbar für das Xiaomi zeitweise als `INCOMPLETE` gemeldet. Nach einem WLAN-Neustart am Xiaomi war die direkte Erreichbarkeit laut Gerätetest wiederhergestellt. Das belegt eine zeitliche Korrelation, aber nicht die eigentliche Fehlerursache.
- Bei der späteren rein lesenden Bestandsaufnahme waren beide Telefone und der Laptop im selben IPv4-/24-Netz und am selben WLAN-Access-Point/BSSID auf 2,4 GHz angemeldet. Die Telefone waren per USB-ADB erreichbar. Die gegenseitigen Nachbartabellen enthielten zu diesem Zeitpunkt passende MAC-Adressen mit Status `STALE`; dieser normale Cachezustand ist kein aktueller Erreichbarkeitsnachweis. Auf dem Laptop waren beide Telefone in der Nachbartabelle `REACHABLE`.
- Die einmalig angezeigten RSSI-Werte waren ungefähr −43 dBm am Xiaomi, −47 dBm am Samsung und −44 dBm am Laptop. Beide Telefone meldeten Bildschirm an, Ladebetrieb und Android-Device-Idle `ACTIVE`. Der Samsung-Status enthielt hohe kumulierte WLAN-Retry-Zähler; Messzeitraum und Zuordnung zum Ausfall sind unbekannt. Daraus folgt keine belastbare Fehlerrate.
- Die Bestandsaufnahme löste weder Pingserien noch Änderungen an WLAN, Router, App, Aufnahme oder Gerätekonfiguration aus. Ein statisch aktiviertes Client-Isolation-Problem, ein Xiaomi-Treiberfehler oder ein AP-Fehler ist damit nicht bewiesen. Das funktionierende Internet beider Geräte garantiert keine direkte Peer-Erreichbarkeit.

## Nächste Untersuchung bei erneutem Fehler

Vor einem WLAN-Neustart und ohne laufende Aufnahme zu stören: Uhrzeit und auf beiden Telefonen jeweils `ip neigh show dev wlan0` sowie `cmd wifi status` aufnehmen und Zustand, IP-/MAC-Zuordnung, BSSID und kurzzeitig verfügbare Zähler vergleichen. Sensible Netzwerknamen, Sitzungscodes und andere Nutzerdaten nicht in öffentliche Logs übernehmen. Nach Ende der Aufnahme kann eine einzelne zeitlich zugeordnete Verbindungsprobe auf jeder Seite helfen; aus einem Paketverlust allein folgt keine Diagnose. Erst nach Sicherung des Zustands eine Veränderung einzeln prüfen und das Ergebnis mit Zeitpunkt dokumentieren.

Als getrennte Hypothesen kommen unter anderem ein vorübergehender Zustand eines Telefons, die Funkstrecke oder die AP-Weiterleitung in Betracht. Ein anderes eigenes Test-WLAN kann bei Gelegenheit die Eingrenzung unterstützen. Für einen robusteren Produktpfad wird direkte WebRTC-Medienübertragung bevorzugt; serververmittelte Signalisierung und ein separat abgesicherter TURN-Fallback sind noch nicht produktiv freigegeben. Ein Signalisierungsserver allein garantiert bei fehlendem direktem Medienpfad kein Livebild.
