# Medienagentur-Zuordnung in Haben – Arbeitsstand

Der vorbereitete Integrationspatch ergänzt Zuordnungen für **Belege, eigene
Rechnungen und einzelne Buchungen**. Als Ziel kommen Videomaker-Projekte,
Kanäle und Plattformen wie YouTube, TikTok und Twitch in Frage. Ein Eintrag
kann mehreren Zielen zugeordnet werden. Die Zuordnung ist Agenturmetadatum in
einer eigenen Haben-Tabelle: Buchungssätze, Beträge und Belegdateien werden
nicht geändert. Änderungen werden über den vorhandenen Haben-Audittrigger
protokolliert. Die Zuordnung eines Belegs wird derzeit **nicht automatisch** auf
seine Buchung übertragen; beide Stellen sind getrennt zu pflegen.

Das Panel auf Beleg-, Rechnungs- und Buchungsseite ist derzeit **fest
deaktiviert**. Weder Umgebungsvariablen noch Einstellungen schalten es frei.
Vorgesehen ist ein Videomaker-Katalog, der ausschließlich IDs, Anzeigenamen
und Plattformen ausgibt; Skripte und andere Projektinhalte bleiben im Studio.
Jedes Auswahlticket ist serverseitig signiert, kurzlebig und an das aktuelle
Videomaker-Cookie gebunden. Es ersetzt weder eine Anmeldung noch den
Haben-Sitzungswächter. `HABEN_AGENCY_CATALOG_SECRET` muss bei späterer
Einrichtung auf beiden Servern identisch, getrennt von allen anderen
Geheimnissen und mindestens 32 Zeichen lang sein. Wenn der Katalog ein früheres
Ziel nicht mehr enthält, zeigt das Panel die bestehende Zuordnung gesondert;
sie wird nicht stillschweigend entfernt. Bei parallelen Änderungen muss der
spätere Speichervorgang neu laden, statt eine andere Änderung zu überschreiben.

Die Prüfung des Videomaker-Logouts erfolgt über einen eigenen Dienst und die
eigentliche Änderung in einer PostgreSQL-Transaktion. Ein bereits geprüftes
Speichern kann noch nach einem unmittelbar folgenden Logout abschließen; der
Test hält die Transaktion an dieser Stelle gezielt an und belegt diese Grenze.
Ein atomarer dienstübergreifender Widerruf ist **nicht** implementiert. Die
Transaktionsgrenze, der Umgang mit hängenden Operationen, Rollen, Schema- und
Proxyprüfung sowie ein echter Dashboard-Ende-zu-Ende-Test müssen vor einer
Freigabe unabhängig geklärt werden.

Die Anpassung liegt als `0006-videomaker-agenturzuordnung.patch` in der
Upstream-Patchfolge und wird vor einer späteren Übernahme automatisch auf einen
isolierten Haben-Kandidaten angewendet. Das Aufspielen und insbesondere die
automatische Produktivübernahme sind weiterhin deaktiviert. Die additive
Migration `0230_videomaker_agency_links` ist Teil des Patches; kollidiert sie
mit einer künftigen Upstream-Migration, muss der Updatecheck abbrechen und der
Patch geprüft sowie angepasst werden. Die Quelldateien und der Patch müssen bei
jeder Änderung auf exakte Übereinstimmung geprüft werden.
