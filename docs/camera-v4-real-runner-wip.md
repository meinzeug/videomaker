# Gesperrter Runner: reale Recorder-Fixture

Dieser isolierte WIP basiert auf `9d2700e`; der Runner und die Android-
Instrumentierung besitzen jeweils eine feste Aus-Sperre. Er ist nicht für
Geräteausführung freigegeben. Der Testserver bleibt lokal und testflaggebunden;
Produktivdaten und Produktivserver werden nicht verwendet.

Die geplante Fixture soll echte Kamera und echtes Mikrofon im eigenen Android-
Testpaket `.journalv4real` öffnen, einen Web-v4-START und STOP ausführen und
einen nach Serverannahme verlorenen ACK-Response auf Anwendungsebene
simulieren. LAN-Readiness ist synthetisch. Die normal verbundene Kamera-App
muss vorab kontrolliert freigegeben werden; ihre Session kann dadurch getrennt
werden und ist erst nach unabhängiger OS-Prüfung wiederherzustellen.

Der Runner verweigert die Vorbereitung, falls das Kamera-Dump die Paketkennung
der regulären App enthält; historische Einträge können vorsichtshalber ebenfalls
zum Abbruch führen. Er hat keinen automatischen Uninstall, kein Force-Stop und
keinen automatischen Wechsel zurück zur Haupt-App. Selbst nach dem testseitigen
Release-Marker bleiben Fixturepaket und Datei zur Prüfung erhalten; eine
zuverlässige, OEM-übergreifende Erkennung der tatsächlichen Medienfreigabe
und ein sicherer Bereinigungs-/Wiederherstellungsablauf sind noch offen.
Der eigene Testserver, seine eigenen ADB-Reverse-Regeln und Testdaten werden
bei normaler Fehlerbehandlung gesondert beendet bzw. entfernt. SIGKILL und
Stromausfall können dennoch manuelle Prüfung erforderlich machen.

`python3 tests/camera-real-fixture-safety.test.py` bestand 3/3 synthetische
Hostfälle: Sperre ohne jede Geräteaktion, Abbruch vor Installation/Serverstart
bei belegter Kamera und fehlende automatische Uninstall-/Force-Stop-Pfade.
Diese Tests simulieren ADB und beweisen weder echtes Android-`dumpsys` noch
Hardwarefreigabe. Kein Gerätetest dieses Entwurfs wurde durchgeführt.
