# Zeitraumbezogene Kontenbewegungen

Die Auswertung liest ein vom Nutzer gewähltes, einschließlich der Grenzen verstandenes Datumsintervall des eigenständigen Buchungsjournals. Sie summiert Soll und Haben je Konto in einer konsistenten SQLite-Lesesicht und zeigt die rechnerische Differenz der als Ertrag beziehungsweise Aufwand klassifizierten Konten. Stornos werden mit ihrem eigenen Buchungsdatum berücksichtigt. Der aktuelle Kontenplan wird vollständig angezeigt; die Angaben über Kontoarten stammen von Nutzern. Zu große Auswertungen werden statt einer unvollständigen Antwort abgelehnt.

Dies ist eine Rechenhilfe für vorhandene Journalbuchungen, kein festgestellter Jahresabschluss, keine Bilanz oder Gewinn- und Verlustrechnung. Weder vollständige Buchführung noch Konto-Einordnung, Eröffnungswerte, Abgrenzungen, Steuern, Abschlussbuchungen oder der rechtliche Anwendungsfall werden überprüft. Aus der dargestellten Differenz wird keine UG-Rücklage abgeleitet und es erfolgt keine Buchung. Ein abweichendes Geschäftsjahr kann als eigener Zeitraum eingegeben werden; die Angaben in den Einstellungen werden nicht automatisch übernommen. Buchungen in anderen Tabs oder auf anderen Geräten erfordern einen neuen Abruf.

Rechtlicher Ausgangspunkt: [§ 242 HGB](https://www.gesetze-im-internet.de/hgb/__242.html) beschreibt Bilanz und Gewinn- und Verlustrechnung als Bestandteile des Jahresabschlusses; [§ 264 HGB](https://www.gesetze-im-internet.de/hgb/__264.html) enthält ergänzende Vorschriften für Kapitalgesellschaften. [§ 5a Abs. 3 GmbHG](https://www.gesetze-im-internet.de/gmbhg/__5a.html) regelt die gesetzliche Rücklage unter Bezug auf den um einen Verlustvortrag aus dem Vorjahr geminderten Jahresüberschuss; Abs. 5 enthält eine besondere Regel für bestimmte Kapitalerhöhungen. Die Auswertung entscheidet nicht, ob die jeweilige Regel anwendbar ist.

## Isolierte HTTP-Fixture

Der optionale HTTP-Test legt synthetische Journalbuchungen in einer eigenen lokalen SQLite-Datenbank an. Er akzeptiert nur Port `3337`, ein markiertes temporäres Verzeichnis und das explizite Schreib-Flag. Niemals ein bestehendes Studio verwenden.

```sh
LEDGER_PERIOD_FIXTURE_DIR=$(mktemp -d /tmp/videomaker-ledger-period-fixture.XXXXXX)
printf 'isolated-ug-period-fixture\n' > "$LEDGER_PERIOD_FIXTURE_DIR/.ug-period-fixture"
printf '%s\n' "$LEDGER_PERIOD_FIXTURE_DIR"
DATA_DIR="$LEDGER_PERIOD_FIXTURE_DIR" ADMIN_PASSWORD=ledger-local-test \
SESSION_SECRET=local-ledger-period-test-secret-123456789 \
npm run dev -- -H 127.0.0.1 -p 3337
```

In einem zweiten Terminal den ausgegebenen Verzeichnispfad einsetzen:

```sh
LEDGER_PERIOD_FIXTURE_DIR=/tmp/videomaker-ledger-period-fixture.XXXXXX \
LEDGER_PERIOD_TEST_SERVER=http://127.0.0.1:3337 LEDGER_PERIOD_TEST_ALLOW_WRITES=1 \
node --experimental-strip-types --test tests/ug-ledger-period-integration.test.mjs
```

Danach den Testserver beenden und nur das eigens angelegte Verzeichnis entfernen. Der Test prüft zusätzlich anhand eines zufälligen Kontos, dass der HTTP-Server die markierte Testdatenbank liest. Die Unit-Tests prüfen unter anderem ein WAL-Snapshot mit paralleler Buchung, Stornos über Datumsgrenzen, Cent-Arithmetik und den Abbruch bei technischen Größenlimits.
