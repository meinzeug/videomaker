# Geräte-Reconnect: isolierter Serverkern

Dieser Stand liegt nur unter `experiments/device-auth/`. Beide Fixture-Flags sind erforderlich; es gibt **keine** öffentliche Route, keinen produktiven Migrationslauf und keinen automatischen Android-Login. Der Kern nutzt ausschließlich ein bereits in der Testdatenbank vorhandenes experimentelles Relay-Paarregister. Eine Admin-/QR-Geräteregistrierung ist hier nicht implementiert.

## Challenge und Schlüsselbeweis

Ein bereits registriertes Gerät erzeugt für jeden Versuch 32 zufällige Bytes als 64 lowercase Hex-Zeichen. `beginDeviceReconnect` erhält Geräte- und Paar-UUID sowie diese `clientChallenge`; Owner und Rolle kommen aus dem registrierten Paar, nicht aus einem frei wählbaren Tenant-Parameter. Die Testdatenbank speichert eine neue Attempt-UUID und eine unabhängige 32-Byte-Servernonce. Eine Challenge ist höchstens 59.990 ms gültig, begrenzt durch Wand- **und** monotone Uhr desselben Linux-Boots. Pro Gerät, Owner und insgesamt gibt es Kapazitätsgrenzen. Ein bereits ausstehendes identisches Clientnonce wird abgewiesen.

Die Challenge-Antwort enthält `attemptId`, `serverNonce`, `expiresAt`, `ownerHash`, `deviceId`, `pairId`, `role` und `serverRevision`. Der künftige Android-Client muss diese Daten gegen sein bestätigtes Geräte-/Peerjournal und die aktuelle Versuchsgeneration prüfen und darf nur über authentifiziertes HTTPS arbeiten.

Der Keystore-P-256-Schlüssel signiert SHA-256/ECDSA als DER über das folgende längencodierte UTF-8-Transkript. Jedes Feld erhält einen vorangestellten **4-Byte-Big-Endian-Bytezähler**, kein Trennzeichen:

1. `videomaker-device-reconnect/v1`
2. `https://videomaker.dorfspy.de`
3. `reconnect`
4. `ownerHash`
5. `deviceId`
6. `pairId`
7. `role` (`camera` oder `prompter`)
8. `attemptId`
9. `clientChallenge`
10. `serverNonce`
11. `serverRevision` als dezimale Zahl ohne führende Nullen

Testvektor: Owner 64×`a`; Geräte-ID `11111111-1111-4111-8111-111111111111`; Paar-ID `22222222-2222-4222-8222-222222222222`; Rolle `camera`; Attempt-ID `33333333-3333-4333-8333-333333333333`; Clientchallenge 64×`b`; Servernonce 64×`c`; Revision `42`. Das Transkript ist 420 Bytes lang; SHA-256: `b86d384caa51c46969ae42c62e72544471eab52af6aad252f658863c1d580432`.

`completeDeviceReconnect` prüft die genaue Attempt-ID, Clientchallenge, Frist, registrierte Identität und Signatur. Nur ein gültiger Beweis verbraucht die Challenge; bei bereits erkanntem Ablauf wird sie vor der Fehlermeldung dauerhaft entfernt. Parallel kann höchstens ein Prozess dieselbe Challenge abschließen. Ein zwischen Challenge und Beweis widerrufenes Paar erhält nach gültigem Beweis eine Antwort mit neuer Revision, `revoked: true` und **ohne** Session-Credential. Ein Gerät muss Widerruf und höchste bestätigte Revision sicher im Peerjournal persistieren, bevor ein späterer Verbindungszustand freigegeben wird.

Die Antwort für ein aktives Paar enthält das Clientchallenge-Echo, Pair-ID, Peer-Device-ID, SHA-256-Fingerprint des Peer-SPKI, aktuelle Revision, `revoked: false`, `ttlMs` und ein zufälliges `sessionCredential`. Dieses kurzlebige Credential wird nur einmal zurückgegeben; die Testdatenbank speichert einen SHA-256-Hash seiner 32 dekodierten Zufallsbytes. `ttlMs` ist höchstens die verbliebene Challenge-Zeit. Der Client muss seine Lease konservativ ab **Beginn** des lokalen Versuchs mit monotoner Uhr berechnen; eine verspätete Antwort verlängert die Serverfrist nicht.

## Zweckgebundener Request-Beweis

Ein Credential allein ist kein Geräteschlüsselbeweis. `authorizeDeviceRequest` verlangt für jede Aktion zusätzlich eine frische 32-Byte-Requestnonce und eine neue P-256-Signatur. Der künftige Serveradapter muss Methode, exakten Pfad und SHA-256-Hash des **tatsächlichen** Request-Bodys selbst bestimmen; sie dürfen nicht ungeprüft aus Client-JSON übernommen werden. Diese vertrauenswürdig abgeleiteten Werte werden getrennt vom Credential/Proof übergeben. Der Testkern erlaubt nur `GET`/`POST` und `/api/turn/credentials` oder `/api/relay/connect`.

Das wieder längencodierte Transkript besteht aus `videomaker-device-request/v1`, festem HTTPS-Origin, `ownerHash`, `deviceId`, `pairId`, `role`, `sessionHash` (SHA-256 der 32 dekodierten Credentialbytes), `requestNonce`, Methode, Pfad und `bodySha256`. Die Nonce wird unter derselben SQLite-Schreibtransaktion wie die Prüfung verbraucht. Derselbe Proof darf kein zweites Mal zum Erfolg führen. Die Liste ist begrenzt; ungültiger Schlüssel, veränderter Body oder Pfad, abgelaufene Sitzung und Geräte-/Paarwiderruf verweigern den Zugriff.

## Prüfungen und offene Freigabeblocker

```sh
node --experimental-strip-types --test tests/device-auth-core.test.mjs
```

Die isolierten Tests prüfen den Testvektor, Schlüsselbindung, Client-/Servernonce, Replay, Grenzen, erkannte Abläufe mit Uhr-Rücksprung, widerrufene Paare/Geräte, getrennten Request-Body und parallelen Challenge-Verbrauch in zwei OS-Prozessen.

Noch offen sind eine echte, einmalig bestätigte Admin-QR-Registrierung, langlebiger Tenant-/Account-Vertrag, ein persistentes processübergreifendes IP-/Account-Ratelimit, ein sicherer HTTPS-Adapter mit einheitlichen Fehlern gegen Geräte-Aufzählung, Android-HTTP-/Keystore-Integration, transaktionale Revisions-/Widerrufspersistenz im Peerjournal, Last-/Crash-/Bootwechseltests und ein sicherer Aufräumvertrag für Fremd-Runtime-Datensätze. Der WSS-Testadapter nutzt bislang Browser-Sitzungsfixtures; diese neue Geräte-Session ist noch **nicht** daran angeschlossen. Sofortiger Widerruf über Workergrenzen hinweg und bereits in Netzpuffern befindliche Bytes sind nicht durch diesen Kern allein gelöst. Ohne diese Prüfungen keine Produktivfreigabe.

## Isolierte Gerätebindung der WSS-Testbrücke

Die Testbrücke kann einen erfolgreichen Geräteschlüssel-Nachweis für `GET /api/relay/connect` über ein nicht serialisierbares, prozesslokales Einmalobjekt übernehmen. Sie überprüft Sitzungs-, Besitzer-, Geräte-, Paarungs-, Rollen- und Revisionsbindung vor Upgrade, bei Anschluss und für jedes Datenstück erneut. Ein lokaler Widerruf kann sofort eine erneute Prüfung auslösen; externe Änderungen werden im Test spätestens beim nächsten Poll bemerkt. Ablauf entfernt die lokale Sitzung dauerhaft. Die Tests verwenden eine echte TLS-WebSocket-/TCP-Verbindung und einen separaten SQLite-Schreiber.

Dies ist keine öffentliche Route und keine Produktionsfreigabe. Die produktive Gerätefreigabe per Admin-QR, mandantenfähige Anmeldung, verteilte Limits und Widerrufssignale sowie Ende-zu-Ende-Tests mit Android fehlen. Polling und Prüfungen pro Datenstück sind keine atomare Sperre bereits gepufferter Netzwerkbytes und kein sofortiges Fencing anderer Worker. Auch ein Rollback der Zustandsdatenbank ist damit nicht abgefangen. TURN-Zugangsdaten und WSS-Weiterleitung dürfen erst nach unabhängiger Prüfung des vollständigen Pfades produktiv freigeschaltet werden.
