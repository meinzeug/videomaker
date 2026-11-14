# OIDC-Anmeldung: vorbereitender Stand

Die gemeinsame Anmeldung für Video-Maker und Haben ist **noch nicht fertig**.
Der bisherige Video-Maker-Login verwaltet ein signiertes Admin-Cookie mit
serverseitigem Widerruf; Haben besitzt eine eigene Anmeldung und einen
OIDC-only-Modus. Ein separat startbarer OIDC-Dienst und die notwendige
Sitzungsbindung sind im WIP vorbereitet, aber nicht produktiv aktiviert. Sie
ersetzen weder eine Produktionsfreigabe noch einen geprüften Proxy- und
Browser-Ende-zu-Ende-Test.

Als Protokollimplementierung wurde die OpenID-zertifizierte Bibliothek
[`oidc-provider`](https://github.com/panva/node-oidc-provider) untersucht. Ihre
[Sicherheitshinweise](https://github.com/panva/node-oidc-provider/blob/main/SECURITY.md)
weisen ausdrücklich darauf hin, dass Entwicklungsschlüssel und der interne
Speicher nicht für den Produktivbetrieb gedacht sind und die Sicherheit eines
eigenen Speicheradapters in der Verantwortung der Anwendung liegt. Der WIP
verwendet `oidc-provider` 9.12.0; ein produktiver Anbieter ist nicht aktiviert.

## Vorbereiteter separater OIDC-Dienst

`scripts/videomaker-oidc-service.mjs` startet nur mit vollständiger expliziter
Konfiguration und bindet ausschließlich an `127.0.0.1`. Der konfigurierte
HTTPS-Issuer muss den Pfad `/oidc` haben; der registrierte Haben-Callback muss
auf demselben Ursprung exakt `/buchhaltung/api/auth/callback/oidc` sein. Es gibt
einen vertraulichen Haben-Client, ausschließlich Authorization Code mit PKCE,
keine dynamische Clientregistrierung und keine Geräte- oder CIBA-Flows. Der
vorbereitete Anbieter kennt genau den bestehenden Video-Maker-Admin als
Inhaber; mehrere Benutzer und Steuerberatungsrollen sind hier nicht umgesetzt.
Die konfigurierte E-Mail ist ein Profilwert und wird nicht als verifiziert
ausgegeben. Subjekt, E-Mail und Gruppen werden ausschließlich serverseitig
vorgegeben, nicht aus Browser-Headern übernommen.

Erforderlich sind `VIDEOMAKER_OIDC_ISSUER`, `VIDEOMAKER_OIDC_REDIRECT`,
`VIDEOMAKER_OIDC_PORT`, `VIDEOMAKER_OIDC_DATABASE`,
`VIDEOMAKER_OIDC_CLIENT_ID`, `VIDEOMAKER_OIDC_CLIENT_SECRET`,
`VIDEOMAKER_OIDC_SUBJECT`, `VIDEOMAKER_OIDC_EMAIL`,
`VIDEOMAKER_OIDC_CACHE_KEY`, `VIDEOMAKER_OIDC_COOKIE_KEYS` und
`VIDEOMAKER_OIDC_JWKS` sowie `VIDEOMAKER_OIDC_BINDING_URL`,
`VIDEOMAKER_OIDC_BINDING_SECRET` und `VIDEOMAKER_OIDC_BINDING_CA`. Cookie-Keys
sind ein JSON-Array; JWKS ist ein JSON-Objekt mit genau einem privaten RSA-Key
mit mindestens 2048 Bit, `alg` `RS256`, `use` `sig` und stabiler `kid`. Die
öffentliche JWKS-Antwort enthält keinen privaten Schlüssel. Geheimnisse sind
stark zufällig und getrennt bereitzustellen, nicht im Repository oder Frontend.
Es werden keine Schlüssel automatisch erzeugt und keine Zugangsdaten geloggt.

Die Datenbank muss separat und geschützt sein. Ihre einmalige explizite Anlage
erfolgt mit `VIDEOMAKER_OIDC_CREATE_DATABASE=1` und absolutem
`VIDEOMAKER_OIDC_DATABASE` beim Aufruf von
`node --experimental-strip-types scripts/prepare-videomaker-oidc-database.mjs`.
Eine bestehende Datei wird nicht geöffnet oder ersetzt. Der Dienst akzeptiert
nur eine markierte Provider-Datenbank mit geschützten Dateirechten. Vor einem
echten Betrieb sind außerdem Speicherquoten, Backup, Restore, Schlüsselrotation,
CA-/Privatschlüsselschutz, ein ausschließlich geeignete Header setzender Proxy
und der Abgleich aller internen TLS-Pfade einzurichten und zu prüfen.

Insbesondere persistieren Provider-Sitzungszuordnungen sowie Verbrauchs- und
Widerrufsmarkierungen derzeit ohne vollständige Quoten- und Dateisystemüberwachung
und ohne geprüfte sichere Retention. Ein produktiver Proxy muss TLS beenden,
eingehende Forwarded-Header entfernen und vertrauenswürdige Header selbst setzen.
Ein Restore muss Provider-Datenbank, Video-Maker-Bindungsdaten und zugehörige
Schlüsselgeneration konsistent behandeln. Für diese Vorgänge gibt es noch kein
freigegebenes, getestetes Betriebs- und Wiederherstellungsverfahren; der Dienst
bleibt bis dahin und bis zum unabhängigen Sicherheitsreview deaktiviert.

Der isolierte Anbieter-Test verwendet ausschließlich Testschlüssel und prüft
Videomaker-Anmeldung, signierten Sitzungs-Claim, PKCE, Replay, Cookie-Tausch
während der Anmeldung, Logout, Code-Widerruf sowie gespeicherte Tokens und
Neuanmeldung nach Anbieter-Neustart. Ausstehende Login-Interaktionen sind nur
im Speicher und müssen nach einem Neustart neu begonnen werden. Die Tests sind
kein Ersatz für den produktiven Haben-Browserlauf oder eine unabhängige Prüfung.

Ein zusätzlicher isolierter Lauf verbindet jetzt **den tatsächlichen**
Videomaker-OIDC-Dienst mit dem tatsächlichen Haben-Callback und PostgreSQL 18:
`tests/fixtures/haben-oidc-service-e2e.test.mjs`. Er prüft Anmeldung unter
`/buchhaltung/`, PKCE, angelegte Inhaberrolle und Sitzungsbindung, Ablehnung
eines wiederverwendeten Codes sowie die Sperre des Haben-Wächters nach
Videomaker-Logout. Die Videomaker-Referenzprüfung läuft dabei im selben
Testprozess; der Haben-Callback wird direkt als Request aufgerufen. Ein echter
Browser, die interne TLS-Strecke und der öffentliche Reverse-Proxy sind durch
diesen Lauf noch nicht abgedeckt. Das Testcluster verwendet ausschließlich
synthetische Datensätze; das produktive System wird nicht angesprochen.

`tests/fixtures/haben-oidc-browser-proxy.test.mjs` ergänzt einen echten
headless Chrome über einen ausschließlich lokalen HTTP-Testproxy. Der Browser
folgt den OIDC-Redirects mit seinen eigenen Cookies; der echte Haben-Auth-Handler
legt die Sitzung in PostgreSQL 18 an und der echte Haben-Wächter verweigert sie
nach Widerruf des Videomaker-Cookies. OIDC-Dienst und Wächter nutzen dabei ihre
tatsächlichen HTTPS-Clients und prüfen eine separate synthetische CA sowie den
festen internen TLS-Namen; der interne TLS-Gegenserver ist eine lokale Fixture.
Die sichtbare Seite ist ebenfalls eine kleine Testseite. Damit sind weder das
echte Haben-Dashboard noch ein öffentliches TLS-/Reverse-Proxy-Deployment
getestet. Chromium wird nur für diesen Test gestartet und geschlossen.

## Was bereits getestet ist

`tests/oidc-storage.test.mjs` prüft isoliert Modelltrennung, Ablauf, atomaren
Verbrauch, Widerruf, Nicht-Wiederbelebung und Persistenz nach erneutem Öffnen
einer separaten Testdatenbank. Der zusätzliche Test
`tests/fixtures/oidc-provider-smoke.mjs` startet den echten Anbieter auf einem
zufälligen Loopback-Port und prüft Authorization Code mit PKCE, eine falsche
PKCE-Eingabe, die Überprüfung des signierten ID-Tokens mit `jose` einschließlich
Issuer, Audience und Nonce, Gruppen über UserInfo sowie die Ablehnung eines
zweiten Code-Tauschs. Er verwendet ausschließlich synthetische Identitäten,
Entwicklungsinteraktionen und temporäre Entwicklungsschlüssel und eignet sich
nicht als Authentifizierungsdienst.

Ein weiterer isolierter Fixturelauf `tests/fixtures/oidc-session-flow.mjs`
verknüpft den echten `oidc-provider` und den echten Video-Maker-Testlogin über
die interne Referenzroute. Er prüft UserInfo vor und nach Logout, einen erst
nach Logout eingelösten Code und den Versuch, eine alte Provider-Session nach
erneuter Video-Maker-Anmeldung wiederzuverwenden. Die Zuordnung liegt dabei in
einer temporären SQLite-Datei, die während des Tests geschlossen und wieder
geöffnet wird. Der Testprovider verwendet Entwicklungsschlüssel und eine
Testinteraktion und darf nie als echter Dienst gestartet werden.

Der Fixture verwendet den vorbereiteten HTTPS-Client `lib/oidc-binding-client.ts`:
Er erlaubt nur den festgelegten internen Pfad auf IPv4-Loopback und authentifiziert
den Zielserver mit eigener CA und festem TLS-Namen. Die CA muss sich auf einem
geschützten, symlinkfreien Pfad befinden. Ungültige Sitzung oder Referenz werden
abgelehnt; bei Konfigurations-, TLS- und Kommunikationsfehlern wird kein Erfolg
angenommen. Der Test erzeugt dafür nur kurzlebige Testzertifikate und einen
lokalen Proxy. Die Operation `match` prüft Referenz und Cookie gemeinsam; der
Test verwendet dafür den echten internen Video-Maker-Endpunkt und weist eine
andere gültige Sitzung sowie die ursprüngliche Sitzung nach Logout ab. Dieser
Client ist noch nicht in einen produktiven OIDC-Anbieter eingebunden; er stellt
selbst weder OIDC noch eine gemeinsame Anmeldung bereit.

Der separate Test `tests/fixtures/haben-oidc-integration.test.mjs` prüft den
echten Haben-Callback mit PostgreSQL 18 und dem echten `oidc-provider` unter
dem Anwendungspfad `/buchhaltung/`. Er erstellt eine synthetische signierte
Video-Maker-Sitzung und verwendet deren echte SQLite-Bindungslogik; der
Testanbieter gibt nur bei aktiver Bindung eine Identität aus. Geprüft werden
PKCE, Callback-Adresse, angelegtes Haben-Konto und Inhaberrolle, Code-Replay
und die Ablehnung einer neuen Anmeldung nach Widerruf der Video-Maker-Referenz.
Der Test ruft Haben direkt über seinen Authentifizierungs-Handler auf; er ist
kein Browsertest und benutzt keinen produktiven Provider oder Proxy. Das
synthetische Video-Maker-Cookie wird den Testanfragen ausdrücklich mitgegeben;
Browser-Redirects, Cookie-Domain und SameSite-Verhalten bleiben zu prüfen. Er belegt
ausdrücklich auch, dass eine bereits erstellte Haben-Sitzung nach Video-Maker-
Logout ohne zusätzlichen Sitzungsschutz bestehen bleibt.

Eine frühere Gegenprobe zeigte, dass der Wächter eine andere gültige
Video-Maker-Sitzung zusammen mit einem alten Haben-Cookie akzeptierte. Der
vorbereitete WIP speichert jetzt bei aktiviertem Wächter den Claim aus dem
signaturgeprüften ID-Token in derselben PostgreSQL-Transaktion wie die neue
Haben-Sitzung. Der Wächter liest die Zuordnung zur tatsächlich authentifizierten
Haben-Sitzung und prüft sie mit dem aktuellen Video-Maker-Cookie. Der isolierte
Test lehnt vertauschte Cookies, fehlende Referenzen und widerrufene Sitzungen ab;
ein Schreibfehler bei der Bindung rollt auch die neue Haben-Sitzung zurück.
Vorhandene Haben-Sitzungen ohne diese Zuordnung werden nach Aktivierung
abgewiesen und benötigen eine neue OIDC-Anmeldung. Der Widerruf schützt
nachfolgende Anfragen; eine bereits laufende Aktion über zwei getrennte Dienste
kann er nicht atomar zurücknehmen.
Ohne Haben-Sitzung bleibt die bisherige Prüfung des Video-Maker-Cookies für den
Anmeldestart erhalten. Der produktive Anbieter und die nötige TLS-/Proxy- und
Browserkonfiguration fehlen weiterhin; der Wächter ist nicht freigegeben.

Hängen Session-Lookups, beendet der Wächter die Anfrage nach zwei Sekunden mit
503. Höchstens zwei noch nicht abgeschlossene Lookups werden zugelassen; ihre
Plätze bleiben bis zum wirklichen Ende belegt. Sie verwenden einen separaten
PostgreSQL-Pool mit begrenzter Verbindungs-, Warteschlangen-, Abfrage- und
Abbruchzeit sowie lokale Datenbankfristen. Der isolierte Test belegt einen
abgebrochenen langsamen PostgreSQL-Befehl und prüft, dass hängende Lookups keine
unbeschränkte Warteschlange erzeugen. Nicht abbrechbare Systemaufrufe können
ihre jeweils belegten Plätze weiterhin länger halten.

Die vorbereitete interne Referenzschnittstelle hat zusätzlich die Operation
`match`: Sie prüft das vorgelegte Video-Maker-Cookie und die OIDC-Referenz
gemeinsam in der Transaktion mit Widerruf und Schlüsselgeneration. Ein gültiges
Cookie einer anderen Sitzung, eine abgelaufene Referenz und ein widerrufenes
Cookie werden abgelehnt. Die Schnittstelle liefert nur den Status, keine
Sitzungsdaten. Der vorbereitete Haben-Wächter nutzt die Operation bei bestehender
Haben-Sitzung; die Referenz wird nur serverseitig gespeichert und nicht in der
öffentlichen Better-Auth-Sitzungsantwort ausgegeben.

Die isolierte Haben-Callback-Gegenprobe stellt außerdem im Testanbieter einen
Claim `videomaker_session_ref` aus der tatsächlich gebundenen Provider-Session
aus. Der Test prüft die ID-Token-Signatur mit den Provider-JWKS, Issuer und
Audience sowie die Übereinstimmung der Referenz mit dem ursprünglichen Cookie.
Ein nachträglich veränderter Claim und das Cookie einer anderen gültigen
Sitzung werden abgewiesen. Der vorbereitete Callback speichert den Claim bei
aktiviertem Wächter atomar mit der Sitzung. Ein produktiver Video-Maker-OIDC-
Anbieter ist noch nicht angeschlossen.

Der Lauf benötigt Node 22, installierte Video-Maker- und Haben-Abhängigkeiten,
die unter `OIDC_PROVIDER_TEST_DIR` separat installierte Testbibliothek
`oidc-provider` und einen leeren, ausschließlich lokalen PostgreSQL-18-
Testcluster. Er löscht und erzeugt dort Testdatenbanken. Der Schutz in
`tests/fixtures/haben-oidc-safety.mjs` verlangt explizite Freigabe, eine
Markierungsdatei mit exakt `VIDEOMAKER HABEN OIDC TEST ONLY` und Zeilenumbruch,
die Datenbank `videomaker_haben_fixture` auf `127.0.0.1` mit explizitem
nichtprivilegiertem Port und bestätigt vor der Vorbereitung anhand der
Servereinstellung `data_directory`, dass der Server zum markierten Testordner
gehört. Die Verbindung und sämtliche Testdaten müssen während des Laufs
exklusiv für diesen Test reserviert sein; die Markierung ist keine Absicherung
gegen einen absichtlichen Austausch des Servers nach der Prüfung. Es darf
keine produktive oder gemeinsam genutzte Datenbank verwendet werden.

```sh
# Cluster, Markierung und leere Datenbank zuvor isoliert vorbereiten.
HABEN_OIDC_DISPOSABLE_CLUSTER=/absoluter/testcluster \
HABEN_OIDC_ALLOW_DISPOSABLE_WRITES=1 \
TEST_DATABASE_URL=postgres://testbenutzer:testpasswort@127.0.0.1:55439/videomaker_haben_fixture \
OIDC_PROVIDER_TEST_DIR=/absoluter/oidc-provider-testordner \
TMPDIR=/absoluter/testcluster \
node apps/buchhaltung/node_modules/vitest/vitest.mjs run \
  --config tests/fixtures/haben-oidc-vitest.config.mjs
```

Für den zusätzlichen Lauf mit dem tatsächlichen Videomaker-OIDC-Dienst dieselbe
isolierte Umgebung verwenden und stattdessen
`--config tests/fixtures/haben-oidc-service-e2e.config.mjs` angeben. Die ererbte
Safety-Prüfung kontrolliert vor dem Datenbank-Setup ebenso Markierung und
`data_directory`; auch dieser Test darf nur auf einem exklusiven Testcluster
laufen, da er Testdatenbanken neu erstellt.

Für den beschriebenen Browser-Fixture denselben Aufbau mit
`--config tests/fixtures/haben-oidc-browser-proxy.config.mjs` nutzen. Er benötigt
zusätzlich das vorhandene `@playwright/test` und `/usr/bin/google-chrome` sowie
genügend RAM. Bei einem Lauf überschritt der langsame PostgreSQL-Checkpoint eine
Stop-Wartezeit von 20 Sekunden, lief aber nach rund 35 Sekunden kontrolliert zu
Ende. Der anschließende HTTPS-Fixturelauf mit 60 Sekunden Stop-Frist war grün
und wurde einschließlich Datenbank geordnet beendet.

Ein reproduzierbarer lokaler Test, ohne das Projekt oder einen Server zu
installieren oder zu verändern:

```sh
node --experimental-strip-types --test tests/oidc-storage.test.mjs
oidc_test_dir="$(mktemp -d)"
npm install --prefix "$oidc_test_dir" --no-audit --no-fund --ignore-scripts oidc-provider@9.12.0
OIDC_PROVIDER_TEST_DIR="$oidc_test_dir" node --experimental-strip-types tests/fixtures/oidc-provider-smoke.mjs
```

Die Bibliotheksversion ist für die Reproduzierbarkeit des Tests gepinnt; vor
einem Produktiveinsatz sind unterstützte Version und Sicherheitsmeldungen
erneut zu prüfen. Die Tests sind keine Zertifizierung des eigenen Adapters.

Der HTTP-Fixturetest `tests/oidc-binding-http.test.mjs` läuft nur mit explizit
freigegebenem lokalen Next-Testserver unter `127.0.0.1:3337`, separatem leeren
Datenverzeichnis und einer Datei `.oidc-test-fixture` mit dem Inhalt
`VIDEOMAKER OIDC TEST ONLY` samt Zeilenumbruch. Dafür müssen im isolierten Server
`OIDC_BINDING_ENABLED=true`, die in den Testdateien genannten synthetischen
Passwörter/Secrets und `DATA_DIR` auf dieses Verzeichnis gesetzt sein. Mit
`OIDC_BINDING_TEST_SERVER`, `OIDC_BINDING_TEST_DATA` und
`OIDC_BINDING_FIXTURE_ALLOW_WRITES=1` wird der Test ausdrücklich aktiviert; er
erstellt dort das Referenzschema. Die Route ist sonst standardmäßig abgeschaltet,
initialisiert weder das OIDC-Schema noch die Projekt-Schemas und öffnet nur eine
bereits vorhandene SQLite-Datei. Sie erwartet ein separates internes Secret
sowie header-only POST mit `Content-Length: 0`. Ein Betrieb erfordert zusätzlich
eine authentifizierte lokale TLS-Verbindung und eine abgesicherte Proxyführung.

Die Referenztabelle enthält keinen Browser-Cookie und keine Klartext-Referenz,
sondern jeweils nur deren Hash, den vorhandenen keyed Widerrufshash und den
Ablauf der Video-Maker-Sitzung. Ausgabe und Logout werden auf derselben SQLite-
Datenbank serialisiert. Neu ausgegebene Referenzen werden für dieselbe gültige
Sitzung und Generation per domain-getrenntem HMAC wiederverwendet, auch nach
einem Anbieter-Neustart. Damit füllen wiederholte Anmeldungen nicht mehr die
16er-Grenze. Es gibt weiterhin maximal 16 aktive Referenzen je Sitzung, 1.024
Referenzen und 1.024 Sitzungsepochen insgesamt; abgelaufene oder widerrufene
Einträge werden transaktional entfernt. Die Provider-Zuordnung speichert dagegen die Referenz als vertraulichen
Wert in der getrennten Provider-Datenbank und darf sie nie umhängen oder
protokollieren. Für beide Datenbanken bleiben Zugriffsschutz und konsistente
Backups nötig.

Ein interner, authentifizierter `reset` kann bei gültigem Video-Maker-Cookie
alle Referenzen genau dieser Sitzung widerrufen. Die gespeicherte Sitzungsepoche
steigt dabei transaktional; eine spätere Ausstellung ergibt eine andere Referenz
und belebt die alte nicht wieder. Das betrifft auch andere Tabs und bereits
ausgegebene Tokens dieser Sitzung bei ihrer nächsten Live-Prüfung; andere
Video-Maker-Sitzungen bleiben bestehen. Der Reset darf nicht unbemerkt bei jeder
Anmeldung ausgelöst werden. Alte, noch aktive Zufallsreferenzen vor dieser
Änderung bleiben bis Ablauf/Widerruf erhalten und können die 16er-Grenze weiterhin
belegen; ein gezielter Reset wäre dort ein Eingriff in bestehende Sitzungen.
Initialisierung, Migration und sichere Betriebsverfahren bleiben vor einem
Produktiveinsatz zu prüfen.

Jede Referenz ist an eine persistente Generation des Video-Maker-`SESSION_SECRET`
gebunden. Eine beobachtete Änderung erhöht diese Generation transaktional; auch
eine spätere Rückkehr zum alten Schlüssel aktiviert alte Referenzen nicht erneut.
Der gespeicherte Fingerprint ist ein domain-separierter HMAC, kein Klartextschlüssel;
für `SESSION_SECRET` ist dennoch ein starkes zufälliges Geheimnis nötig. Eine
explizite Initialisierung älterer OIDC-Bindungstabellen erhält ihre Daten, markiert
alte Referenzen aber als ungültig. Ohne passenden, ausreichend langen Schlüssel
scheitert die Prüfung geschlossen.

Vor dem Freigeben einer Schlüsselrotation müssen alle Instanzen mit altem Schlüssel
gestoppt und der neue Schlüssel auf allen neuen Instanzen konsistent gesetzt werden.
Nach expliziter Schemavorbereitung muss unter den vorgesehenen Dienstvariablen
`DATA_DIR` und `SESSION_SECRET` der administrative Aufruf
`OIDC_BINDING_OBSERVE_KEY=1 node --experimental-strip-types scripts/oidc-observe-session-key.mjs`
erfolgreich beendet sein, bevor Nutzerverkehr zugelassen wird. Der Aufruf legt
weder Datenbank noch Schema an und gibt den Schlüssel nicht aus. Die Anwendung
erzwingt diesen Startschritt noch nicht automatisch; seine verlässliche Integration
und Überwachung sind vor Inbetriebnahme erforderlich. Ein nie beobachteter oder
nicht erfolgreich in SQLite bestätigter Schlüsselwechsel sowie ein vollständiger
Datenbank-Rollback lassen sich nicht allein aus dieser Tabelle erkennen. Weiter
laufende alte Instanzen können zudem neue alte Sitzungen erzeugen; sie müssen
bei der Rotation ausgeschlossen werden.

Bereits gespeicherte Grant-Zuordnungen dürfen weder geändert noch entfernt werden.
Eine erstmalige Zuordnung nach dem Speichern erlaubt der Adapter ausschließlich
für `DeviceCode` und `BackchannelAuthenticationRequest`: Der untersuchte
`oidc-provider` ergänzt dort die Grant-ID nach der ursprünglichen Ausgabe. Diese
beiden optionalen Flows sind im echten PKCE-Test nicht durchlaufen und müssen bis
zu einer eigenen Ende-zu-Ende-Prüfung deaktiviert bleiben. Auch die Anpassung
selbst benötigt vor einem produktiven Einsatz einen unabhängigen Review.

## Vor einer sicheren Integration erforderlich

- Eine echte Provider-Konfiguration mit festem Issuer, registriertem Haben-Client,
  exakter Callback-URL, vertraulichem Clientsecret, PKCE, kurzlebigen Codes und
  ausschließlich vorgesehenen Scopes. Dynamische Registrierung und andere nicht
  benötigte Flows bleiben deaktiviert.
- Eine nachweislich sichere Verknüpfung der Provider-Interaktion mit der aktuellen
  Video-Maker-Sitzung und ihrem Widerruf, inklusive Logout-Rennen und geklauter
  oder bereits widerrufener Cookies. Ohne gültige Sitzung darf die Testlogik
  keinesfalls eine Identität ausgeben. Eine dauerhafte eindeutige Subject-ID,
  eine gültige E-Mail und die Haben-Gruppenzuordnung müssen serverseitig festgelegt
  werden; keine Rechtevergabe anhand gleichlautender E-Mail-Adressen.
- Eine produktive Provider-Integration muss sicherstellen, dass eine erstmalige
  Zuordnung nur für eine nachweislich neu erstellte Provider-Session erfolgt und
  bei jeder Code-/Token- und UserInfo-Nutzung die unveränderliche Zuordnung live
  geprüft wird. Der Fixture testet dieses Verhalten, aber keine produktive
  Provider-Implementierung. Ein vollständiger Rollback einer der getrennten
  Datenbanken oder ein Logout genau zwischen interner Prüfung und Tokenausgabe
  erfordert ein gesondertes konsistentes Betriebs- und Transaktionskonzept;
  der zusätzliche Haben-Wächter prüft geschützte Zugriffe erneut.
- Getrennte dauerhafte Datenbank mit restriktiven Dateirechten, Sicherungs- und
  Wiederherstellungskonzept sowie Aufbewahrungsregeln. Der Adapter speichert
  vertrauliche Protokolldaten; der Zugriff auf Datenbank und Backups kann Zugang
  ermöglichen. Verbrauchs-, Lösch- und Widerrufsmarkierungen wachsen dauerhaft und
  dürfen nicht ohne belegbar sichere Aufbewahrungsregeln gelöscht werden.
- Sicherer Betrieb und Rotation dauerhafter Signaturschlüssel, Clientsecrets und
  TLS-Zertifikate außerhalb des Repositories sowie abgesicherte Provider- und
  Proxy-Endpunkte. Niemals die im Test verwendeten Entwicklerschlüssel nutzen.
- Unabhängige Sicherheitsprüfung des Adapters und des vollständigen Flows,
  einschließlich mehrerer Prozesse, Last, Zeitänderungen, Replay, Fehlkonfiguration,
  Ausfall, Wiederanlauf und Wechsel bereits vorhandener Haben-Konten. Der
  vorhandene optionale Haben-Sitzungswächter ist ein zusätzlicher Schutzbaustein,
  keine SSO-Implementierung; Details stehen in
  `apps/buchhaltung/.videomaker/ANMELDUNG.md`.

## Aufbewahrung der Widerrufsmarkierungen

Der vorbereitete Baustein `lib/oidc-capacity.ts` kann auf bereits geöffneten
SQLite-Verbindungen Tabellenbestände und die logische Datenbankgröße messen.
Er benötigt für jede Kennzahl ausdrücklich konfigurierte Warn- und kritische
Grenzen, meldet deren Erreichen und gibt weder Referenzen noch Sitzungsdaten aus.
Providerdatenbank und Video-Maker-Sitzungsdatenbank werden einzeln gemessen;
es gibt keinen gemeinsamen atomaren Zustand. Fehlendes Schema oder ungültige
Grenzen führen zu einem Fehler, nicht zu einer gesunden Statusmeldung. Die
Messung ändert weder Schema noch Einträge und startet keinen Provider. Sie ist
noch nicht an einen Dienst oder ein Überwachungssystem angeschlossen.

`databaseBytes` ist `page_count * page_size`, also die logische Größe der
SQLite-Hauptdatenbank inklusive freier Seiten. WAL-, Shared-Memory-, Backup- und
Dateisystembelegung sind darin nicht enthalten; freier Platz, tatsächlicher
Dateiverbrauch und Quoten müssen zusätzlich betrieblich überwacht werden. Eine
Momentaufnahme reserviert keinen Speicher und verhindert keine nachfolgenden
Schreibzugriffe. Tabellenstände wachsen bewusst weiter; die Messung bereinigt
keine Widerrufsmarkierungen und setzt keine produktiven Grenzwerte voraus.

Es gibt bewusst **keine automatische Löschung** der Tabellen
`oidc_consumed_objects` und `oidc_revoked_grants`. Auch die Tabelle
`oidc_provider_session_map` wächst dauerhaft, enthält vertrauliche Referenzen und
besitzt noch keine automatische Kapazitäts- oder Bereinigungsstrategie. Ein blindes
Löschen würde die einmalige UID-Zuordnung aufheben. `oidc_consumed_objects`
enthält auch Löschmarkierungen für nie verbrauchte oder bereits abgelaufene
Objekte sowie beim Widerruf entfernte Einträge, damit verspätete Schreibvorgänge
sie auch unter einer anderen Freigabe nicht wiederbeleben können. Diese
Sperre gilt pro Modell und ID auch dann, wenn beim Löschen kein Datensatz mehr
vorhanden war. Ein Datum allein ist kein
sicherer Löschbeleg: Nach Uhrkorrektur, Wiederherstellung eines älteren Backups
oder einem verspäteten Speichervorgang könnten alte Codes oder Freigaben sonst
wieder nutzbar werden. Vor einem Betrieb müssen Tabellengröße und freier
Speicherplatz überwacht sowie Warn- und Kapazitätsgrenzen festgelegt werden.
Der Adapter speichert zudem den höchsten beobachteten Zeitwert. So bleibt ein
bereits beobachteter Ablauf bei einer rückwärts gestellten Uhr ungültig. Ein
nicht beobachteter Zeitsprung oder das Zurückspielen einer vollständigen älteren
Datenbankkopie wird dadurch nicht erkannt. Ein irrtümlicher großer Zeitsprung in
die Zukunft kann umgekehrt neue Sitzungen beeinträchtigen; ein sicheres
Wiederanlaufverfahren dafür ist vor dem Einsatz festzulegen.

Abgelaufene sekundäre Suchkennungen (`uid` und `userCode`) dürfen für neue
Objekte wiederverwendet werden, damit insbesondere kurze Gerätecodes nicht
dauerhaft blockiert bleiben. Dazu werden nur die Suchindex-Spalten des bereits
abgelaufenen Eintrags innerhalb derselben Transaktion freigegeben; Objekt-ID,
Inhalt, Ablauf und Sperrmarkierungen bleiben erhalten. Der persistente
Zeit-Höchststand verhindert, dass der alte Eintrag bei einer Uhrkorrektur
wieder gültig wird.

Eine mögliche spätere Bereinigung ist nur als geprüfter Wechsel auf eine neue
Identitätsgeneration denkbar: alle Provider-Instanzen und Ausstellungen
anhalten, aktive Sitzungen und Tokens gezielt ungültig machen, zulässige maximale
Tokenlaufzeiten und Offline-Prüfer berücksichtigen, Signatur- und Cookieschlüssel
geordnet wechseln, sämtliche alten Wiederanmelde- und Wiederherstellungswege
abschneiden und erst dann auf eine neue leere Speichergeneration wechseln.
Betroffene müssen sich erneut anmelden. Backups der alten Generation müssen
zugehörige Schlüssel und Sperrmarkierungen konsistent erhalten und dürfen nicht
unbemerkt in die neue Generation zurückgespielt werden. Das ist noch kein
implementiertes oder sicherheitsgeprüftes Verfahren und darf nicht automatisiert
ausgeführt werden; bis dahin bleiben alle Markierungen erhalten.
