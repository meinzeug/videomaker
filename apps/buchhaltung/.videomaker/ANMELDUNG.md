# Gemeinsame Anmeldung mit Video-Maker

Stand: Die Unterpfad-Integration besitzt **noch keine gemeinsame Sitzung**.
Haben und Video-Maker haben eigene Anmeldungen. Die im Unterpfad-Browsertest
geprüfte lokale Haben-Anmeldung ist kein Nachweis für Single Sign-on.

Ein optionaler zusätzlicher Sitzungswächter ist vorbereitet: Bei
`HABEN_VIDEOMAKER_SESSION_GUARD=required` fragt Haben die Video-Maker-Sitzung für
geschützte Anfragen über `HABEN_VIDEOMAKER_SESSION_URL` auf IPv4-Loopback unter
dem festen Pfad `/api/internal/buchhaltung/session` ab. Das gemeinsame Secret
`HABEN_VIDEOMAKER_INTERNAL_SECRET` muss mindestens 32 Zeichen lang sein und
Video-Makers `BUCHHALTUNG_SESSION_CHECK_SECRET` entsprechen. Der lokale Aufruf
übermittelt nur das Video-Maker-Sitzungscookie und das Secret; nur Status 204
erlaubt die Anfrage. Keine Anmeldung, Fehler und Timeout führen zu 401 bzw. 503.
Jede Anfrage wird neu geprüft; ein Erfolg wird nicht zwischengespeichert.
Standardmäßig ist dieser Wächter aus und ändert Upstreams Verhalten nicht.
Im Pflichtmodus tragen auch erfolgreiche von der Middleware bearbeitete Antworten
`Cache-Control: private, no-store`. Ob ein Browser nach Logout eine zuvor
angezeigte Seite über seinen Zurück-Vorwärts-Speicher kurz wiederherstellt,
ist damit nicht abschließend geklärt und muss gesondert getestet werden.

**Der Wächter ist noch nicht für den Produktivbetrieb freigegeben.** Das Secret
authentifiziert Haben gegenüber Video-Maker, aber die Loopback-Verbindung weist
die Identität des angesprochenen Servers nicht nach. Ein fremder lokaler Prozess
könnte bei einem Ausfall den Port besetzen, Cookie und Secret entgegennehmen und
eine erfolgreiche Prüfung vortäuschen. Vor der Aktivierung ist eine beidseitig
authentifizierte Verbindung zu implementieren und zu prüfen, beispielsweise mit
mTLS oder einem Unix-Socket mit restriktiven Zugriffsrechten und geprüftem Peer.

REST/MCP mit eigener Bearer-Authentifizierung und der GET-OIDC-Callback haben
eng begrenzte Ausnahmen; der Bank-Callback bleibt geschützt. Der Wächter ist
keine allein ausreichende Perimetersperre: Statische Dateien können vom
Nitro-Server vor der Anwendungsmiddleware ausgeliefert werden. Der Dienst muss
an Loopback gebunden und der öffentliche Proxy entsprechend abgesichert sein.
Auch dieser Baustein erzeugt keine Haben-Sitzung und löst kein Single Sign-on.

## Ausgangslage

Video-Maker verwaltet gegenwärtig eine signierte Admin-Sitzung im Cookie
`kontrakurs_session`; ihre Gültigkeit und ihr Widerruf werden serverseitig in
`lib/auth.ts` und `lib/session-revocations.ts` geprüft. Haben hat getrennte
PostgreSQL-Sitzungen und unterstützt einen strikt getrennten OIDC-only-Modus.
Darin prüft es unter anderem Issuer, Signatur, Audience, Nonce, PKCE und die
Gruppenzugehörigkeit; lokale Passwörter, Passkeys und Einladungen sind in diesem
Modus nicht verwendbar. Video-Maker bietet bisher keinen OIDC-Anbieter.

Eine reine OIDC-Konfiguration genügt für sofortigen Widerruf nicht: Haben
bewahrt die bestätigte Gruppenberechtigung bis zu 15 Minuten und speichert keine
Provider-Tokens zum laufenden Nachfragen. Eine bloße Übergabe eines Benutzernamens
oder einer Rolle in Proxy-Headern wäre keine Anmeldung und darf nicht verwendet
werden. Ein einseitiges Löschen des Browser-Cookies widerruft keine kopierte
Haben-Sitzung.

## Schnittstelle und Prüfungen für die Umsetzung

1. Einen geeigneten, gewarteten OIDC-Anbieter mit Video-Makers Identitäten
   verbinden. Für Haben einen eigenen vertraulichen Client und Redirect
   `/buchhaltung/api/auth/callback/oidc` registrieren. Codes müssen einmalig,
   kurzlebig und an PKCE, Client und Redirect gebunden sein; Signierschlüssel
   und Clientsecret bleiben serverseitig. Ein dauerhafter, eindeutiger Subject
   und ausdrücklich konfigurierte Inhaber-/Steuerberatungsgruppen sind nötig.
   Keine Zuordnung allein anhand einer E-Mail-Adresse.
2. Haben mit `OIDC_ONLY=true` und fest vorgegebenem, vertrauenswürdigem Issuer
   betreiben. Der Übergang von vorhandenen lokalen Konten erfordert den
   dokumentierten Übernahmeprozess, Backup und einen geprüften Rückweg; die
   Betriebsart nie automatisch während eines Updates umschalten. Anmeldung
   kann anschließend aus der Video-Maker-Oberfläche zum OIDC-Flow führen.
3. Zusätzlich muss vor **jeder geschützten Browseranfrage** die aktuelle
   Video-Maker-Sitzung einschließlich Widerruf serverseitig geprüft werden,
   beispielsweise durch einen explizit konfigurierten Reverse-Proxy-Aufruf an
   einen dafür vorgesehenen, lesenden Video-Maker-Endpunkt. Bei fehlender,
   abgelaufener oder widerrufener Sitzung sowie bei Ausfall der Prüfung muss
   der Zugriff scheitern. Keine aus dem öffentlichen Netz gelieferten
   Authentifizierungsheader übernehmen. Die Prüfung darf keine Sessionwerte
   protokollieren, zwischenspeichern oder in URLs schreiben.
4. Routen mit anderen, bereits vorhandenen Authentifizierungsverfahren nicht
   pauschal aussperren oder ungeprüft freigeben: Insbesondere REST/MCP mit
   Bearer-Token und Bank-/OIDC-Callbacks müssen nach ihren eigenen Regeln geprüft
   werden. Ein OIDC-Callback kann nach einer externen Navigation ohne das
   `SameSite=Strict`-Video-Maker-Cookie eintreffen; eine sichere, eng definierte
   Callback-Ausnahme benötigt State-, Nonce- und PKCE-Prüfung. Das Zusammenspiel
   ist für jeden tatsächlich unterstützten Zugangspfad zu testen.
5. In einer isolierten Umgebung Login, Einrichtung, Browser-Navigation,
   widerrufene und kopierte Cookies, direkten Zugriff auf Haben, gefälschte
   Header, Sitzungsablauf, gleichzeitigen Logout und Schreibanfrage, API-Tokens,
   Callbacks, Proxy-/Identitätsdienst-Ausfall und einen Rollback prüfen. Der
   Haben-Prozess darf dabei nie direkt aus dem öffentlichen Netz erreichbar
   sein. Eine Anfrage, die bereits vor dem Widerruf erfolgreich autorisiert
   wurde, braucht für strenge Garantien bei schreibenden Vorgängen zusätzlich
   eine transaktionale Prüfung unmittelbar vor dem Commit; zwei getrennte
   Datenbanken machen diese Garantie zu einer eigenen Architekturaufgabe.

Erst nach Implementierung und Prüfung dieser Schnittstellen darf die Oberfläche
eine gemeinsame Anmeldung oder einen sofortigen gemeinsamen Logout behaupten.
