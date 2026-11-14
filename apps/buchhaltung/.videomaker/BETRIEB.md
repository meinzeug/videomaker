# Buchhaltung ohne Container betreiben

Der importierte Quelltext ist ein Teil des Video-Maker-Repositories. Haben benötigt
zur Laufzeit einen eigenen Serverprozess und eine eigene PostgreSQL-Datenbank;
Docker ist dafür nicht erforderlich. Die Unterpfad-Anpassung ist noch nicht
vollständig im produktiven Zusammenspiel erprobt. Diese Datei beschreibt die
Voraussetzungen und ist keine Freigabe für eine Serverübernahme.

## Voraussetzungen

- Bun in der Version aus `package.json` und PostgreSQL 18. Einen vorhandenen
  PostgreSQL-Cluster nicht überschreiben oder ohne geprüften Migrations- und
  Wiederherstellungsplan auf eine andere Major-Version aktualisieren.
- Eigene Datenbank und getrennte Rollen für Anwendung und Migrationen. Die
  Zugangsdaten und die Schlüssel `BETTER_AUTH_SECRET` und
  `HABEN_ENCRYPTION_KEY` gehören ausschließlich in eine geschützte
  Laufzeitkonfiguration außerhalb des Git-Repositories. Bei der Wiederherstellung
  muss insbesondere der Verschlüsselungsschlüssel erhalten bleiben.
- Persistente, gesicherte Verzeichnisse für Belege und gegebenenfalls ERiC,
  Laufzeitprotokolle und eigene Vorlagen. Die vollständige Variablenreferenz steht
  in `docs/installation-konfiguration.md`; Betriebsdaten, Datenbank und Schlüssel
  müssen gemeinsam gesichert und der Restore vorab überprüft werden.
- Ein nur lokal erreichbarer Haben-Dienst hinter dem vorhandenen HTTPS-Proxy.
  Der Proxy muss `/buchhaltung` auf `/buchhaltung/` kanonisieren und Anfragen unter
  `/buchhaltung/` **mit unverändertem Präfix** an Haben weiterleiten. Bestehende
  Video-Maker-Routen und der Teleprompter dürfen nicht umgeleitet werden.

## Build und Laufzeit

Im Verzeichnis `apps/buchhaltung` mit den projektgebundenen Abhängigkeiten:

```sh
bun install --frozen-lockfile
HABEN_BASE_PATH=/buchhaltung bun run build
```

Der Unterpfad wird beim Build festgelegt. In der geschützten Prozessumgebung muss
`BETTER_AUTH_URL=https://videomaker.dorfspy.de/buchhaltung` gesetzt sein; außerdem
werden mindestens `DATABASE_URL`, `BETTER_AUTH_SECRET` und `HABEN_ENCRYPTION_KEY`
benötigt. `PORT` und die Bind-Adresse müssen so eingerichtet werden, dass der
Dienst von außen nur über den HTTPS-Proxy erreichbar ist. Der gebaute Prozess
wird aus `apps/buchhaltung/apps/web` mit `bun .output/server/index.mjs` gestartet.

Migrationen sind ein gesonderter, geplanter Schritt: `bun run db:migrate` liest
seine Datenbankadressen aus der Prozessumgebung und darf vor einem getesteten
Backup und Restore nicht gegen bestehende Daten gestartet werden. Weitere
Einzelheiten und Rollentrennung stehen in `docs/installation-konfiguration.md`.

## Vor einer Übernahme

Lokal und auf einer isolierten Testdatenbank müssen mindestens Build, Anmeldung,
Einrichtung, Navigation, API, Beleg-Upload und -Download, Schreibvorgänge,
Sitzungsende, Backup und Wiederherstellung unter dem echten Unterpfad geprüft
werden. Datenmigrationen und eine gemeinsame Anmeldung mit Video-Maker sind
gesondert zu entwickeln und Ende zu Ende zu prüfen; die Unterpfad-Anpassung
stellt keine gemeinsame Sitzung her. Vor Änderungen an laufenden Diensten oder
Datenbanken sind ein vollständiges Backup und ein getesteter Rückweg notwendig.

Für einen ersten echten Browserlauf liegt `unterpfad-smoke.mjs` bereit. Es legt
ein synthetisches Konto an und ist deshalb **ausschließlich für eine leere,
isolierte Testdatenbank und einen lokalen Testserver** vorgesehen. Das Skript
verweigert andere Hosts und verlangt eine ausdrückliche Kennzeichnung als
Wegwerfinstanz. Nach Vorbereitung der Datenbank, Migration und Start des nur
lokal erreichbaren Testservers beispielsweise:

```sh
TEST_HABEN_DISPOSABLE=1 \
TEST_HABEN_BASE_URL=http://127.0.0.1:3199/buchhaltung/ \
HABEN_SETUP_CODE=TEST-CODE-1234 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome \
node .videomaker/unterpfad-smoke.mjs
```

Der Beispielcode muss dem beim Start der Testinstanz gesetzten Code entsprechen.

Der Aufruf prüft Manifest, Service-Worker-Scope, OpenAPI, Einrichtung,
Navigation sowie Ab- und Anmeldung. Er ersetzt weder den vollständigen
Funktionstest noch die Sicherungs- und Wiederherstellungsprüfung.

Die Update-Vorbereitung und die Lizenzhinweise stehen in `UPSTREAM.md`, `LICENSE`
und `NOTICE`. Ein neuer Upstream-Stand darf nicht ungeprüft im laufenden Betrieb
eingespielt werden.
