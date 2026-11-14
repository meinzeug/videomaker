# OIDC-Anmeldung: vorbereitender Stand

Die gemeinsame Anmeldung für Video-Maker und Haben ist **noch nicht fertig**.
Der bisherige Video-Maker-Login verwaltet ein signiertes Admin-Cookie mit
serverseitigem Widerruf; Haben besitzt eine eigene Anmeldung und einen
OIDC-only-Modus. Der vorbereitete SQLite-Adapter in `lib/oidc-storage.ts` ist
nirgends eingebunden und startet keinen Dienst. Zusätzlich sind eine
standardmäßig abgeschaltete interne Sitzungsreferenz-Schnittstelle und eine
unveränderliche Provider-Sitzungszuordnung vorbereitet. Sie sind keine
Produktionsfreigabe und aktivieren selbst keinen OIDC-Anbieter.

Als Protokollimplementierung wurde die OpenID-zertifizierte Bibliothek
[`oidc-provider`](https://github.com/panva/node-oidc-provider) untersucht. Ihre
[Sicherheitshinweise](https://github.com/panva/node-oidc-provider/blob/main/SECURITY.md)
weisen ausdrücklich darauf hin, dass Entwicklungsschlüssel und der interne
Speicher nicht für den Produktivbetrieb gedacht sind und die Sicherheit eines
eigenen Speicheradapters in der Verantwortung der Anwendung liegt. Video-Maker
enthält derzeit weder diese Abhängigkeit noch einen aktivierten OIDC-Anbieter.

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
lokalen Proxy. Dieser Client ist noch nicht in einen produktiven OIDC-Anbieter
eingebunden; er stellt selbst weder OIDC noch eine gemeinsame Anmeldung bereit.

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

Die Gegenprobe ruft nach einem echten Haben-Callback auch den vorhandenen
optionalen Wächter mit dem ausgestellten Haben-Sitzungscookie auf. Er weist das
ursprüngliche, danach widerrufene Video-Maker-Cookie ab. Eine **andere gültige**
Video-Maker-Sitzung zusammen mit demselben alten Haben-Cookie lässt er jedoch
durch: Der Wächter prüft bislang nur, ob irgendeine Video-Maker-Sitzung gültig
ist, und bindet sie nicht an die Haben-Sitzung. Die Gegenprobe dokumentiert das
aktuelle Verhalten, keine Sicherheitsfreigabe. Für eine echte Bindung müssen
der vertrauenswürdige OIDC-Anbieter einen nachweislich an die ursprüngliche
Video-Maker-Sitzung gebundenen Wert liefern, Haben diesen im geprüften Callback
unveränderlich der neu erstellten Sitzung zuordnen und der Wächter diese
Zuordnung mit dem aktuellen Cookie einschließlich Widerruf prüfen. Eine
Zuordnung erst beim ersten Zugriff nach dem Login ist dafür nicht ausreichend.
Der dafür notwendige produktive Anbieter und die transaktionale Zuordnung
existieren noch nicht; der Wächter darf nicht als gebundener gemeinsamer Logout
dargestellt werden.

Die vorbereitete interne Referenzschnittstelle hat zusätzlich die Operation
`match`: Sie prüft das vorgelegte Video-Maker-Cookie und die OIDC-Referenz
gemeinsam in der Transaktion mit Widerruf und Schlüsselgeneration. Ein gültiges
Cookie einer anderen Sitzung, eine abgelaufene Referenz und ein widerrufenes
Cookie werden abgelehnt. Die Schnittstelle liefert nur den Status, keine
Sitzungsdaten. Dies ist ein Baustein und noch keine Korrektur des Haben-Wächters:
Der vom Anbieter signierte Referenz-Claim und dessen unveränderliche Bindung an
die konkrete Haben-Sitzung beim Callback fehlen weiterhin.

Die isolierte Haben-Callback-Gegenprobe stellt außerdem im Testanbieter einen
Claim `videomaker_session_ref` aus der tatsächlich gebundenen Provider-Session
aus. Der Test prüft die ID-Token-Signatur mit den Provider-JWKS, Issuer und
Audience sowie die Übereinstimmung der Referenz mit dem ursprünglichen Cookie.
Ein nachträglich veränderter Claim und das Cookie einer anderen gültigen
Sitzung werden abgewiesen. Dieser Test weist nur die Transportmöglichkeit nach:
Der vorhandene Haben-Callback speichert oder verwendet den Claim noch nicht;
auch ein produktiver Video-Maker-OIDC-Anbieter ist noch nicht angeschlossen.

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
Datenbank serialisiert. Es gibt maximal 16 aktive Referenzen je Sitzung und
1.024 insgesamt; abgelaufene oder widerrufene Referenzen werden transaktional
entfernt. Die Provider-Zuordnung speichert dagegen die Referenz als vertraulichen
Wert in der getrennten Provider-Datenbank und darf sie nie umhängen oder
protokollieren. Für beide Datenbanken bleiben Zugriffsschutz und konsistente
Backups nötig.

Ein interner, authentifizierter `reset` kann bei gültigem Video-Maker-Cookie
alle Referenzen genau dieser Sitzung widerrufen und so nach verwaisten Provider-
Neustarts die 16er-Grenze freigeben. Das betrifft auch andere Tabs und bereits
ausgegebene Tokens dieser Sitzung bei ihrer nächsten Live-Prüfung; andere
Video-Maker-Sitzungen bleiben bestehen. Der Reset darf nicht unbemerkt bei jeder
Anmeldung ausgelöst werden. Ein künftiger Provider muss seinen Lebenszyklus
explizit damit koordinieren und nach dem Reset eine neue Provider-Session erzeugen;
die alte UID darf nie neu zugeordnet werden. Die Probe und die Route allein
implementieren diese Orchestrierung noch nicht, daher bleibt die Kapazitätsgrenze
bis dahin ein Betriebsblocker.

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
