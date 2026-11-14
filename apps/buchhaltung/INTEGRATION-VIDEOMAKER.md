# Einbindung in Video-Maker: technischer Zwischenstand

Der vollständige Haben-Quelltext wird hier unter Erhalt von `LICENSE` und `NOTICE` weiterentwickelt.
Für eine Installation unter `/buchhaltung/` muss beim Build `HABEN_BASE_PATH=/buchhaltung` gesetzt
werden. Dieselbe öffentliche Adresse einschließlich Unterpfad muss in `BETTER_AUTH_URL` stehen,
beispielsweise `https://videomaker.dorfspy.de/buchhaltung`. Der Reverse Proxy muss diesen Pfad
einschließlich Präfix weiterreichen. Die Einstellung wird beim Build fest eingebunden und kann nicht
erst zur Laufzeit geändert werden.

Die Unterpfad-Integration ist noch nicht für den produktiven Buchhaltungsbetrieb freigegeben. Vorher
sind insbesondere Builds und Browserprüfungen im Root und Unterpfad nötig, einschließlich Anmeldung,
Passkeys, SSO-Callbacks, Upload/Download, API, PWA, Bank-Callback und Wiederherstellung. Auch die
Anbindung an die Video-Maker-Anmeldung, die Datenübernahme und der native Serverbetrieb sind gesondert
umzusetzen und zu prüfen.
