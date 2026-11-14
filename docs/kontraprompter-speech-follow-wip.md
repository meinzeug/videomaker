# KontraPrompter: Speech-Follow (Entwurf)

Xiaomi ist in der aktuellen Testaufstellung die Kamera, Samsung der Teleprompter. Speech-Follow ist noch nicht in der Android-App implementiert. Dieser Entwurf schaltet keine Spracherkennung, Cloudübertragung oder KI ein.

## Ausgangspunkt

Videomaker besitzt bereits einen Browser-Sprachmodus: `app/use-speech-follow.ts` nutzt browserabhängige Web Speech Recognition; `lib/speech-follow.ts` normalisiert und sucht erkannte Wörter vorwärts im Skript. Je nach Browser kann das Audio einen externen Dienst erreichen. Der bestehende Webcode fällt bei nicht nutzbarer Audiospur gegebenenfalls auf das Browsermikrofon zurück. Das ist noch kein Nachweis für die Stimme des Kamera-Smartphones.

Die Android-Kamera nimmt Ton bereits mit `AudioRecord` für die MP4 auf; ein zusätzlich geöffneter Mikrofon- oder `SpeechRecognizer`-Aufnehmer kann auf manchen Geräten konkurrieren oder stumm bleiben. Der aktuelle Android-WebRTC-Vorschaustrom enthält eine Videospur, aber noch keine Live-Audiospur. Der Web-Matcher benötigt mindestens zwei Treffer und verwendet eine relativ niedrige Trefferquote; bei Wiederholungen oder vorläufigen Erkennungsfehlern sind Sprünge möglich. Er ist Ausgangspunkt für Tests, keine geprüfte Echtzeitlösung.

## Zielablauf

- Die Kamera erfasst den Mikrofonton **einmal** und erhält die Qualität und Synchronität der Originalaufnahme. Ein begrenzter Analysepuffer darf den Recorder niemals blockieren; bei Überlast verwirft die Analyse Daten, nicht die Aufnahme. Gemeinsame Ressourcennutzung, Zeitstempel und saubere Freigabe müssen auf den Geräten nachgewiesen werden.
- Eine ausdrücklich aktivierte, möglichst vollständig lokale Spracherkennung verarbeitet die Stimme. Modell, Ressourcenbedarf, Lizenz, Integritätsprüfung und echte Offlinefähigkeit sind vor Auswahl zu prüfen; keine Annahme, dass eine bestimmte Android-Erkennungs-App vorhandene PCM-Daten oder Offlinebetrieb unterstützt. Bei Modellen zum Nachladen müssen Herkunft, Prüfsumme und Speicherbedarf vor Nutzung feststehen.
- Liegt dasselbe Skript auf der Kamera vor, kann sie die erkannten Wörter lokal gegen dessen bestätigte Fassung abgleichen und nur geordnete Positionen an den Prompter senden. Alternativ kann Samsung empfangene Sprache lokal auswerten, sofern die Audio-/Erkennungspipeline nachweisbar mit dem bestehenden Aufnahmepfad funktioniert. Wo lokale Skripte noch nicht auf der Kamera vorliegen, ist zunächst eine identische Skriptfassung über den bereits authentisierten, Ende-zu-Ende-verschlüsselten Kanal herzustellen oder eine andere sichere Datenführung zu implementieren. Ein Projekt-ID-Vergleich allein beweist keine Textgleichheit.
- Jede Positionsmeldung bindet Paarung, Sitzungsgeneration, Skriptfassung und Sequenznummer. Der Teleprompter verwirft alte, doppelte oder fremde Meldungen. Beim Scriptwechsel, manuellen Zurücksetzen, Netzwechsel und erneuter Kopplung darf kein alter Zustand wieder vorscrollen.
- Stille stoppt das Fortschreiten. Wiederholungen, Versprecher, Zahlen, Abkürzungen und vorläufige Erkennungsergebnisse dürfen nicht zu großen Fehlsprüngen führen. Nutzer können jederzeit pausieren, die Position korrigieren und auf manuelles Tempo umstellen. Bei Erkennungs- oder Mikrofonfehlern bleibt die Aufnahme erhalten und der sichtbare Status nennt den Fehler.
- Der direkte Smartphone-Medienpfad wird bevorzugt. Nach erfolgreicher Signalisierung muss der Direktbetrieb auch bei einem temporären Studioausfall weiterlaufen. Ein Server-Relay ist nur Fallback und darf Sprachdaten oder Skripte nicht unverschlüsselt einsehen. Keine Roh-Audio- oder Transkriptübertragung an externe KI-Dienste ohne erkennbare, ausdrücklich aktivierte Auswahl.

## Prüfungen vor Freigabe

1. Gemeinsamer deutschsprachiger Testkorpus für Web- und Android-Matcher: Satzzeichen, Umlaute, ß, zusammengesetzte Wörter, Zahlen, Versprecher, Wiederholungen, lange Pausen, Sprecherwechsel, Hintergrundton, Skriptwechsel und manuelle Rücksprünge. Falsch-positive Vorwärtssprünge und maximale Distanz messbar begrenzen.
2. Xiaomi-Aufnahme mit und ohne Analyse vergleichen: Audiospur, Bild/Ton-Synchronität, Dropouts, CPU, Speicher, Wärme, Akkubedarf und Aufnahmefehler. Samsung-Anzeige und Position anhand des tatsächlich gesprochenen Wortes mit Zeitstempeln prüfen; die zulässige Latenz muss aus den Messungen festgelegt werden.
3. Zwei Geräte bei direktem WLAN und bei isolierten WLAN-Clients mit sicherem Fallback testen; ausgewählten ICE-Pfad und fortlaufenden Direktstream bei anschließendem Studioausfall nachweisen. Alte, doppelte oder verspätete Positionsbefehle dürfen keine Bewegung auslösen.
4. Offline-Modell, Mikrofonberechtigung, blockierten/ausgelasteten Erkenner, unterbrochene Verbindung, Widerruf und manuelle Bedienung testen. Keine echten Aufnahmen oder Projekte für Tests überschreiben oder löschen.
