// Nur gegen eine leere, isolierte Testinstanz ausführen: legt ein synthetisches Konto an.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
if (process.env.TEST_HABEN_DISPOSABLE !== "1" || !process.env.TEST_HABEN_BASE_URL) {
  throw new Error("Nur für eine leere, isolierte Testinstanz: TEST_HABEN_DISPOSABLE=1 und TEST_HABEN_BASE_URL setzen.");
}
const base = new URL(process.env.TEST_HABEN_BASE_URL);
if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password || base.pathname !== "/buchhaltung/" || base.search || base.hash) {
  throw new Error("TEST_HABEN_BASE_URL muss eine lokale Testinstanz unter /buchhaltung/ sein.");
}
const code = process.env.HABEN_SETUP_CODE;
if (!code || code.length < 8) throw new Error("HABEN_SETUP_CODE der isolierten Testinstanz fehlt.");

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const address = (path = "") => new URL(path, base).toString();
  const manifestResponse = await page.request.get(address("manifest.webmanifest"));
  assert.equal(manifestResponse.status(), 200, "Manifest erreichbar");
  const manifest = await manifestResponse.json();
  assert.equal(new URL(manifest.start_url, address("manifest.webmanifest")).pathname, "/buchhaltung/");
  assert.equal((await page.request.get(address("sw.js"))).status(), 200, "Service Worker erreichbar");
  const apiResponse = await page.request.get(address("api/v1/openapi.json"));
  assert.equal(apiResponse.status(), 200, "OpenAPI erreichbar");
  assert.equal((await apiResponse.json()).servers[0].url, "/buchhaltung/api/v1");

  await page.goto(address(), { waitUntil: "networkidle" });
  await page.waitForURL("**/buchhaltung/setup");
  await page.getByLabel("Einrichtungscode").fill(code);
  await page.getByLabel("Name").fill("Testperson");
  await page.getByLabel("E-Mail").fill("isoliert@example.invalid");
  await page.getByLabel(/Passwort/).fill("nur-ein-synthetisches-testpasswort");
  await page.getByRole("button", { name: "Konto anlegen" }).click();
  await page.getByRole("button", { name: "Später" }).click();
  await page.waitForURL("**/buchhaltung/einstellungen");
  const scope = await page.evaluate(async () => Promise.race([
    navigator.serviceWorker.ready.then((registration) => registration.scope),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Service Worker nicht registriert")), 10_000)),
  ]));
  assert.equal(new URL(scope).pathname, "/buchhaltung/", "Service Worker greift nur im Unterpfad");

  await page.goto(address("belege"), { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/buchhaltung/belege");
  await page.goto(address("rechnungen"), { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/buchhaltung/rechnungen");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await page.waitForURL("**/buchhaltung/login");
  await page.getByRole("button", { name: "Passwort verwenden" }).click();
  await page.getByLabel("E-Mail").fill("isoliert@example.invalid");
  await page.getByLabel("Passwort").fill("nur-ein-synthetisches-testpasswort");
  await page.getByRole("button", { name: "Mit Passwort anmelden" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/buchhaltung/") && !url.pathname.endsWith("/login"));
  assert.deepEqual(errors, [], "keine unbehandelten Browserfehler");
  console.log("Unterpfad-Smoke erfolgreich: Manifest, Worker, API, Einrichtung, Navigation, Ab- und Anmeldung.");
} finally {
  await browser.close();
}
