# Interne Sitzungsprüfung für Buchhaltung

`GET /api/internal/buchhaltung/session` ist ein Baustein für die noch nicht
fertiggestellte gemeinsame Anmeldung. Er prüft das vorhandene Videomaker-Cookie
einschließlich der serverseitigen Widerrufsliste und gibt bei gültiger Sitzung
`204`, andernfalls `401` zurück. Konfigurations- oder Datenbankfehler führen zu
`503`. Antworten enthalten weder Cookie noch Sitzungsdaten und sind nicht cachebar.

Der Aufruf benötigt zusätzlich den Header `X-Videomaker-Internal-Secret`. Beide
Dienste müssen denselben zufällig erzeugten Schlüssel über geschützte
Umgebungsdateien außerhalb des Repositories erhalten. Videomaker liest ihn aus
`BUCHHALTUNG_SESSION_CHECK_SECRET`; ohne ausreichend langen Schlüssel ist die
Schnittstelle deaktiviert. Schlüssel niemals an den Browser ausgeben oder
protokollieren. Im Produktivbetrieb muss der Reverse-Proxy den externen Zugriff
auf `/api/internal/buchhaltung/session` sperren; der Aufruf erfolgt ausschließlich
über eine lokale, nicht öffentlich erreichbare Verbindung.

Dieser Endpunkt erzeugt keine Haben-Sitzung und ersetzt weder OIDC noch dessen
Gruppenprüfung. Vor Aktivierung müssen die Anmeldung, der sofortige Widerruf, alle
benötigten Callback-Pfade und der Schutz vor Umgehung Ende zu Ende geprüft werden.
