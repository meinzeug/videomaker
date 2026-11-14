# Grok-Skripterstellung

Neue Erstellungen nutzen serverseitig OpenRouter mit `OPENROUTER_API_KEY`. Das
Standardmodell ist `x-ai/grok-4.3`, das Ersatzmodell `x-ai/grok-4.20`. Beide sind
über `SCRIPT_MODEL` und `SCRIPT_FALLBACK_MODEL` konfigurierbar. Skript und
einmaliger Korrekturversuch verwenden Temperatur 0,85, das Faktenblatt 0,3;
beide nutzen `top_p` 0,95, höchstens 4.000 Tokens und 120 Sekunden pro Anfrage.
Die separate Webrecherche verwendet Temperatur 0,4 und `RESEARCH_MODEL`, falls
gesetzt, sonst `SCRIPT_MODEL` bzw. Grok 4.3. Für Recherche gilt ebenfalls das
4.000-Token- und 120-Sekunden-Limit. Reasoning wird für diese Grok-Schritte
deaktiviert, damit es nicht das kleine Ausgabebudget verbraucht.

Im Kontrakurs-Standard ist der vom Nutzer vorgegebene Systemprompt unverändert
in `lib/grok-prompt.ts` hinterlegt. Die ausdrücklich gewählte Einstellung „nur
umformulieren“ ist eine bewusste Ausnahme: Sie verwendet einen eigenen Prompt,
der keine persönliche Bewertung erzwingt. Für Kontrakurs gelten die formalen Pflichtsätze und die Wortzahl auch im Umformuliermodus. Andere Kanäle erhalten eine neutrale kanalgebundene Vorlage und ihre gespeicherten Kanalangaben sowie gewählte Gestaltungsvorgaben. Für andere Kanäle gelten plattformgerechter Umfang und Abschluss statt der Kontrakurs-Pflichtsätze; ein gesondertes redaktionelles Kanal-Preset ist derzeit nicht hinterlegt. Bestehende gespeicherte Projekte bleiben im
bisherigen Format und alte bereits erhaltene Providerantworten auswertbar.

Das Faktenblatt ist ein KI-Entwurf und garantiert weder Wahrheit noch eine
vollständige oder korrekte Artikelinterpretation. Wörtliche Zitate werden nur
übernommen, wenn derselbe Wortlaut im tatsächlich abgerufenen und gespeicherten
Seitentext der angegebenen Quelle vorkommt. Dies beweist lediglich das
Vorkommen im extrahierten Seitentext, nicht die Zuordnung zum Artikel oder die
Richtigkeit. Nicht belegte Zitate werden weggelassen und im internen
Hinweisfeld vermerkt. Bei Webrecherchen ohne gespeicherten Originaltext werden
keine Zitate als wörtlich belegt übernommen. Recherchehinweise aus dem
Faktenblatt werden beim Skriptaufruf nicht mitgesendet und bleiben getrennt
vom Telepromptertext. Die mechanische Zitatprüfung erkennt nicht jede indirekt
formulierte Behauptung oder sinngemäße Rede; Inhalte müssen geprüft werden.

Die Skript- und Korrekturanfragen fordern ein striktes JSON-Schema mit festgelegten Feldtypen und drei Titeln an. Die Anwendung prüft die Antwort weiterhin selbst, da ein Provider das Schema ignorieren kann. Unabhängige Feld- und Inhaltsfehler werden gesammelt und dem einzigen Korrekturversuch gemeinsam mitgeteilt.

Die Ergebnisprüfung kontrolliert vor dem Speichern bei Kontrakurs unter anderem Pflichtsätze und Wortzahl; für andere Kanäle gelten diese Vorgaben nicht. Die verbotenen Muster werden bei allen geprüft. Offensichtliche fremde Kanalbegrüßungen lösen eine Korrektur aus, lassen sich aber nicht vollständig automatisch erkennen. Bei Fehlern folgt höchstens
ein Korrekturaufruf. Ist auch diese Antwort ungültig oder abgeschnitten, wird
sie nicht als fertiges Skript gespeichert. Gespeicherte Providerantworten und
der Status bleiben für angemeldete Nutzer abrufbar. `content.script` bleibt
der Telepromptertext; Titel, Thumbnail, Pinnkommentar und interne Hinweise
werden separat gespeichert. Da das verlangte JSON keine B-Roll-Ideen enthält,
ist das vorhandene B-Roll-Array leer.

Bei Faktenblatt, Skript und Korrektur wird jeder Versuch vor dem Netzwerkaufruf dauerhaft reserviert. Die separate Webrecherche protokolliert Versuche, hat aber keine dauerhaft fortsetzbaren Zwischenstände; ein manueller Neustart kann weitere Kosten auslösen. Zeitüberschreitung
oder Netzwerkabbruch dürfen nach ausdrücklicher Vorgabe einen Versuch mit dem
Ersatzmodell auslösen; bei HTTP 429/5xx gibt es insgesamt höchstens zwei Wiederholungen einschließlich des Ersatzmodells mit Backoff. Eine zeitweise unklare Anfrage kann vom Provider trotzdem
berechnet werden; fehlende Kostenangaben sind **unbekannt**, nicht null. Modell,
Provider-ID, gelieferte Token-/Kostenangaben und Versuchszustand werden ohne
Schlüssel, Quelltext oder Prompt protokolliert. Nach einem Prozessabbruch wird
ein möglicherweise bereits gestarteter Modellaufruf nicht automatisch erneut
gestartet. Ein sicher gespeicherter Zwischenstand kann ausdrücklich fortgesetzt
werden; dabei können weitere KI-Kosten entstehen.
Bei Authentifizierungs-, Berechtigungs- oder Guthabenfehlern (401/402/403)
wird kein Ersatzmodell aufgerufen, weil derselbe Schlüssel den Fehler nicht
behebt; diese Fehler müssen zuerst behoben werden.

Die letzte Sitzungsprüfung und der Beginn eines Netzaufrufs sind nicht über
mehrere Prozesse atomar. Ein bereits gestarteter Aufruf kann nach einem Logout
weiterlaufen; das Projekt wird vor dem Speichern erneut unter SQLite-Sperre
auf die gültige Sitzung geprüft. Bildplanung und Bildgenerierung sind getrennte
Funktionen und können nach Erstellung des Projekts weitere KI-Kosten auslösen.
