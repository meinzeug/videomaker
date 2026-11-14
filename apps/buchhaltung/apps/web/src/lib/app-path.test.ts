import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prefixAppPath } from "./app-path.ts";

describe("Anwendungspfade", () => {
  it("behält Pfade bei einer Installation im Root unverändert", () => {
    expect(prefixAppPath("/", "/api/beleg/123?download#view")).toBe("/api/beleg/123?download#view");
  });

  it("setzt bei einer Installation im Unterpfad den Basispfad voran", () => {
    expect(prefixAppPath("/buchhaltung/", "/api/beleg/123?download#view")).toBe("/buchhaltung/api/beleg/123?download#view");
    expect(prefixAppPath("/buchhaltung/", "/")).toBe("/buchhaltung/");
  });

  it("lehnt fremde und relative Ziele ab", () => {
    expect(() => prefixAppPath("/buchhaltung/", "//example.org/x")).toThrow();
    expect(() => prefixAppPath("/buchhaltung/", "https://example.org/x")).toThrow();
    expect(() => prefixAppPath("/buchhaltung/", "api/x")).toThrow();
  });

  it.each(["/", "/buchhaltung/"])("begrenzt das PWA-Manifest auf %s", (base) => {
    const manifest = JSON.parse(readFileSync(new URL("../../public/manifest.webmanifest", import.meta.url), "utf8"));
    const manifestUrl = `https://example.org${base}manifest.webmanifest`;
    expect(new URL(manifest.scope, manifestUrl).pathname).toBe(base);
    expect(new URL(manifest.start_url, manifestUrl).pathname).toBe(base);
    for (const icon of manifest.icons) expect(new URL(icon.src, manifestUrl).pathname.startsWith(base)).toBe(true);
    for (const shortcut of manifest.shortcuts) expect(new URL(shortcut.url, manifestUrl).pathname.startsWith(base)).toBe(true);
    expect(new URL(manifest.share_target.action, manifestUrl).pathname).toBe(`${base}api/belege/teilen`);
  });
});
