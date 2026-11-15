# Isolierter Cross-Runtime-v2-Test

`tests/owned-device-cross-runtime.test.mjs` prüft ausschließlich mit synthetischer SQLite-Datenbank die Interoperation zwischen Kotlin-Softwaresignierer und Node-Ownerkern: Enrollment-Bindung, Abweisung anderer Owner/Workspaces, Replay, Projektgrant und Gerätewiderruf. Der Test wird nur ausgeführt, wenn ein eigens unter `/dev/shm/studio-owned-device-cross.*` erstellter Klassenpfad ausdrücklich übergeben wird; ohne ihn wird er als übersprungen gekennzeichnet.

Das zugehörige Skript `experiments/studio-owned-device/run-cross-test.py` liegt im getrennten Android-WIP und bereitet den Klassenpfad vor. Der gezielt gestartete Test lief tatsächlich und bestand (1/1); der zugehörige Kotlin-Unitlauf bestand ebenfalls (5/5). Er ersetzt weder reale Android-Keystore-/HTTPS-Tests noch eine produktive Route oder die Autorisierung realer Konten und Projekte.
