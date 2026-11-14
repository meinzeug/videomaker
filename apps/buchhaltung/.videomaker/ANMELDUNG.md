# Gemeinsame Anmeldung mit Video-Maker

Stand: Die Unterpfad-Integration besitzt **noch keine gemeinsame Sitzung**.
Haben und Video-Maker haben eigene Anmeldungen. Die im Unterpfad-Browsertest
geprüfte lokale Haben-Anmeldung ist kein Nachweis für Single Sign-on.

Ein optionaler zusätzlicher Sitzungswächter ist vorbereitet: Bei
`HABEN_VIDEOMAKER_SESSION_GUARD=required` fragt Haben die Video-Maker-Sitzung für
geschützte Anfragen über eine HTTPS-Adresse in `HABEN_VIDEOMAKER_SESSION_URL`
auf IPv4-Loopback unter dem festen Pfad `/api/internal/buchhaltung/session` ab.
`HABEN_VIDEOMAKER_SESSION_CA_FILE` bezeichnet die absolute Pfadangabe einer
eigens für diesen Dienst vertrauenswürdigen CA. Das Serverzertifikat muss den
DNS-Namen `videomaker-session.internal` als Subject Alternative Name enthalten.
Haben verwendet ausschließlich diese CA und prüft Zertifikat und Namen vor der
Übermittlung von Zugangsdaten. Die CA-Datei muss regulär, höchstens 64 KiB groß,
kein Symlink und für Gruppe und andere nicht schreibbar sein; Eigentümer muss
root oder der laufende Dienstbenutzer sein. Sämtliche
übergeordneten Verzeichnisse müssen ebenfalls vor fremdem Schreiben geschützt
werden. Das gemeinsame Secret
`HABEN_VIDEOMAKER_INTERNAL_SECRET` muss mindestens 32 Zeichen lang sein und
Video-Makers `BUCHHALTUNG_SESSION_CHECK_SECRET` entsprechen. Der lokale Aufruf
übermittelt nur das Video-Maker-Sitzungscookie und das Secret; nur Status 204
erlaubt die Anfrage. Keine Anmeldung, Fehler und Timeout führen zu 401 bzw. 503.
Jede Anfrage wird neu geprüft; ein Erfolg wird nicht zwischengespeichert.
Je Haben-Prozess werden höchstens 16 Prüfungen gleichzeitig bearbeitet; bei
Überlastung folgt 503 ohne Warteschlange. Zusätzlich braucht der öffentliche
Proxy eine Ratenbegrenzung. Die Zwei-Sekunden-Frist begrenzt die Antwortzeit;
ein vom Betriebssystem nicht abbrechbarer Dateisystemaufruf kann danach noch
weiterlaufen. Solche ausstehenden CA-Zugriffe bleiben ebenfalls begrenzt.
Standardmäßig ist dieser Wächter aus und ändert Upstreams Verhalten nicht.
Im Pflichtmodus tragen auch erfolgreiche von der Middleware bearbeitete Antworten
`Cache-Control: private, no-store`. Ob ein Browser nach Logout eine zuvor
angezeigte Seite über seinen Zurück-Vorwärts-Speicher kurz wiederherstellt,
ist damit nicht abschließend geklärt und muss gesondert getestet werden.

**Der Wächter ist noch nicht für den Produktivbetrieb freigegeben.** Vor einer
Aktivierung müssen ein ausschließlich lokal erreichbarer TLS-Endpunkt für die
Video-Maker-Prüfroute, eine eigene CA und ein passendes Serverzertifikat
bereitgestellt werden. Nur das CA-Zertifikat gelangt in den lesbaren Haben-Pfad;
CA-Signierschlüssel und Serverprivatschlüssel müssen getrennt und mit restriktiven
Rechten geschützt bleiben. Der TLS-Endpunkt muss ausschließlich die beabsichtigte
Video-Maker-Prüfroute weiterleiten; seine Ausfall- und Wiederanlaufbedingungen,
Zertifikatserneuerung und ein Rollback sind auf dem Zielsystem zu testen. Das
Secret authentifiziert Haben gegenüber Video-Maker. Gemeinsame Anmeldung und
vollständige Browser- und Proxyprüfung bleiben zusätzlich offen.

Eine frühere Gegenprobe zeigte, dass eine andere Video-Maker-Sitzung mit einem
alten Haben-Cookie den Wächter passieren konnte. Im vorbereiteten WIP erhält
Haben beim verifizierten Callback eine signierte Sitzungsreferenz, speichert sie
atomar zur Haben-Sitzung und prüft sie bei späteren Anfragen zusammen mit dem
Video-Maker-Cookie. Das interne Secret für diese Prüfung ist
`HABEN_VIDEOMAKER_BINDING_SECRET` und muss dem Video-Maker-Wert
`OIDC_BINDING_INTERNAL_SECRET` entsprechen. Der lokale TLS-Proxy muss zusätzlich
den festen Pfad `/api/internal/oidc/session-binding` weiterleiten. Ein echter
produktiver OIDC-Anbieter, Proxy und Browsertest fehlen weiterhin; daher bleibt
der gesamte Wächter deaktiviert. Testgrenzen stehen in `docs/oidc-anmeldung.md`.

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
