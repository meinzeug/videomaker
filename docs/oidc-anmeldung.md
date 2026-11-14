# OIDC-Anmeldung: vorbereitender Stand

Die gemeinsame Anmeldung für Video-Maker und Haben ist **noch nicht fertig**.
Der bisherige Video-Maker-Login verwaltet ein signiertes Admin-Cookie mit
serverseitigem Widerruf; Haben besitzt eine eigene Anmeldung und einen
OIDC-only-Modus. Der vorbereitete SQLite-Adapter in `lib/oidc-storage.ts` ist
nirgends eingebunden und startet keinen Dienst. Er ist keine Produktionsfreigabe.

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

Es gibt bewusst **keine automatische Löschung** der Tabellen
`oidc_consumed_objects` und `oidc_revoked_grants`. `oidc_consumed_objects`
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
