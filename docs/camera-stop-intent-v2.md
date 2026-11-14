# Kamera-Stopp: vorbereiteter Serverbaustein

Der Baustein `lib/camera-stop-intent.ts` ist im nur lokal aktivierbaren Kamera-API-Pfad verdrahtet, aber noch nicht an Android angebunden. Die Kamera-API bleibt standardmäßig und in Produktion vollständig deaktiviert. Ein erfolgreicher Funktionstest ist keine Freigabe der Fernsteuerung.

Bei Registrierung einer steuerbaren Kamera muss dieselbe Datenbanktransaktion einen Stoppplatz für diese Kamera anlegen. Die Anzahl der Plätze ist damit durch die Gerätequote begrenzt, auch wenn die übliche Befehlsquote ausgeschöpft ist. Für eine bestätigte Aufnahme in `preparing` oder `recording` kann ein dauerhafter, auf Geräte- und Aufnahme-ID beschränkter Stopp angefordert werden. Mehrfache Anfragen und erneute Zustellungen verwenden dieselbe ID; sie fügen keine Befehlszeilen hinzu. Beim Poll wird dem Gerät das kurze Zeitfenster für die einzelne Zustellung mitgegeben. Das Gerät muss die vollständige Umlaufzeit des Polls vom Fenster abziehen. Der Auftrag selbst verfällt nicht: Nach einer verstrichenen Zustellung muss Android dieselbe Stopp-ID bei einer frischen Zustellung erneut prüfen können. Bei `preparing` wird der Stopp vorgemerkt. Eine andere Aufnahme darf niemals angehalten werden.

Eine ACK-Quittung bedeutet weder, dass die Aufnahme gestoppt ist, noch dass eine Datei oder ein Cloud-Upload existiert. Erst ein serialisiert erfasster Zustand `finalizing`, `ready`, `partial` oder ein auf die gleiche Aufnahme bezogenes `error` beendet die Zustellung. Der Stoppplatz bleibt für die nächste Aufnahme blockiert, solange dieser Zustandsnachweis fehlt. Ein voller oder defekter Datenträger kann auch das Speichern des Stoppwunsches verhindern; die Bedienoberfläche muss dann die unbestätigte Ausführung und die Möglichkeit zum lokalen Stopp zeigen.

Vor Integration und Freischaltung müssen insbesondere diese Punkte umgesetzt und Ende zu Ende getestet sein:

- Die Gerätebindung mit nicht exportierbarem Android-Keystore-Schlüssel und einmaliger kurzlebiger Challenge ist im Testpfad verdrahtet. Integration, Android-/Server-Neustarts und E2E sind noch zu testen; Schlüsselverlust braucht einen klaren Wiederherstellungsweg für offene Aufnahmen.
- Android-Integration für serialisierte Polls einschließlich Zustandssnapshot und Sequenz. Ein Android-Prozess muss angenommene START-Entscheidungen vor ACK dauerhaft speichern und nach Absturz nie blind erneut starten.
- Der Testpfad setzt beim START atomar eine Projektsperre. Nur ein ticketauthentifizierter READY-Nachweis mit unveränderlicher Geräte-, Aufnahme-, Projekt-, Größen- und SHA-Bindung sowie ein exakt passender verifizierter Uploadbeleg geben sie frei. Kamera-Uploads werden erst nach dem Gerätenachweis angenommen; eine reservierte Upload-ID und transaktionale Uploadsperre verhindern die Belegung durch andere Daten. PARTIAL bleibt offen und ist nicht als fertiges Cloudvideo hochladbar. Der explizite Umgang mit Geräteverlust bleibt offen. Projekt- und Einzelaufnahme-Dateilöschung werden nach dem DB-Commit über dauerhafte Jobs ausgeführt, die beim Serverstart und danach begrenzt erneut versucht werden; `cleanupPending` meldet verbleibende Aufgaben.
- Sichere begrenzte Aufbewahrung und Wiederholungsschutz: Zeitlich befristete, authentifizierte Startberechtigungen und Archivierung ausschließlich nach Ablauf dieser Frist und eindeutigem Abschluss; unklare und offline befindliche Aufnahmen nicht automatisch löschen. Eine Kapazitätssperre muss verständlich angezeigt werden.
- Geeignetes Generationen- und Uhrmodell für mehrere Serverworker und System-Suspend oder ausdrücklicher Betrieb mit einem Worker. ENOSPC, Neustarts, konkurrierende Starts, Stopps und Projektlöschungen müssen getestet werden.
- UI zeigt ausschließlich tatsächliche Geräte- und Uploadbestätigungen. `ready` bedeutet eine lokal gespeicherte Aufnahme; ein Cloud-Erfolg benötigt den überprüften Uploadbeleg.

## Geräteanmeldung und Uploadzuordnung

Die v2-Registrierung wird über `POST /api/camera-devices/pairing/challenge` mit `{"deviceId":"<persistente UUID>","action":"register"}` begonnen. `session` startet nach Registrierung eine neue Ticket-Anfrage. Die Antwort enthält `challengeId`, 32 zufällige Bytes als `challenge` (base64url, ohne Padding) und `expiresInMs`. Für den Abschluss erhält `/api/camera-devices/pairing/complete` Geräte-ID, Aktion, Challenge-ID sowie `payload` und `signature` als ungepolstertes base64url. Die Payload ist bei Registrierung der öffentliche P-256-Schlüssel als SPKI-DER und bei Session leer. Die ASN.1-DER-ECDSA-Signatur über SHA-256 umfasst exakt diese UTF-8-Bytes einschließlich letztem Zeilenumbruch:

```text
videomaker-camera-device-auth/v2
<device-id>
<challenge-id>
<challenge>
<action>
<sha256-hex-der-payload>
```

Die Session-Antwort enthält ein kurzlebiges, an das Gerät und die aktuelle Studio-Anmeldung gebundenes Ticket. Bei jedem Poll wird es als `X-Camera-Device-Ticket` übermittelt; die Poll-`id` bleibt die dauerhaft gespeicherte Geräte-ID und die Sequenz wird darüber hinweg atomar fortgeschrieben. Für fernzugeordnete Video-Uploads bleibt die bestehende deterministische `X-Recording-Id` erhalten; zusätzlich kennzeichnet `X-Camera-Recording-Id` die ursprüngliche Kamera-Aufnahme. Der Server prüft die deterministische Bindung an Aufnahme und Projekt und ordnet nur einen tatsächlich verifizierten Uploadbeleg dem Projektclaim zu.
