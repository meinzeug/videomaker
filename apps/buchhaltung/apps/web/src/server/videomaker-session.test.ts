import { afterEach, describe, expect, it, vi } from "vitest";
import { guardVideomakerSession } from "./videomaker-session.ts";

const config = { mode: "required", endpoint: "http://127.0.0.1:3000/api/internal/buchhaltung/session", secret: "s".repeat(32) };
const request = (path = "/buchhaltung/belege", cookie = "kontrakurs_session=12345.test.signature", method = "GET") =>
  new Request(`http://localhost:3199${path}`, { method, headers: { cookie, "x-forwarded-user": "inhaber" } });

afterEach(() => vi.unstubAllEnvs());

describe("Video-Maker-Sitzungsprüfung", () => {
  it("ist ohne Aktivierung rückwärtskompatibel und lehnt fehlerhafte Pflichtkonfiguration ab", async () => {
    const send = vi.fn();
    expect(await guardVideomakerSession(request(), { ...config, mode: undefined }, send)).toBeNull();
    for (const invalid of [
      { ...config, mode: "requred" },
      { ...config, endpoint: undefined },
      { ...config, secret: "short" },
      { ...config, endpoint: "https://example.com/api/internal/buchhaltung/session" },
      { ...config, endpoint: "http://localhost:3000/api/internal/buchhaltung/session" },
      { ...config, endpoint: "http://127.0.0.1:3000/andere" },
      { ...config, endpoint: "http://127.0.0.1:3000/api/internal/buchhaltung/session?token=1" },
      { ...config, endpoint: "http://user:pass@127.0.0.1:3000/api/internal/buchhaltung/session" },
    ])
      expect((await guardVideomakerSession(request(), invalid, send))?.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it("verwendet nur das Video-Maker-Cookie und das interne Secret, niemals Browser-Header", async () => {
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await guardVideomakerSession(request("/buchhaltung/belege", "haben=privat; kontrakurs_session=12345.test.signature"), config, send)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.endpoint);
    expect(init.headers).toEqual({ cookie: "kontrakurs_session=12345.test.signature", "X-Videomaker-Internal-Secret": config.secret });
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("weist fehlende, widersprüchliche oder manipulierte Cookies ohne Anfrage ab", async () => {
    const send = vi.fn();
    for (const cookie of ["", "haben=foo", "kontrakurs_session=", "kontrakurs_session=a; kontrakurs_session=b", "kontrakurs_session=a,b"]) {
      const result = await guardVideomakerSession(request("/buchhaltung/", cookie), config, send);
      expect(result?.status).toBe(401);
      expect(result?.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("prüft jede Anfrage neu und akzeptiert nach Widerruf keine kopierte Sitzung", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await guardVideomakerSession(request(), config, send)).toBeNull();
    expect((await guardVideomakerSession(request(), config, send))?.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("schließt bei Ausfällen, Weiterleitungen und unerwarteten Antworten", async () => {
    for (const send of [
      async () => {
        throw new Error("Netzfehler");
      },
      async () => new Response(null, { status: 302, headers: { location: "https://example.com" } }),
      async () => new Response(null, { status: 200 }),
      async () => new Response(null, { status: 503 }),
    ])
      expect((await guardVideomakerSession(request(), config, send))?.status).toBe(503);
  });

  it("nimmt nur tokenbasierte APIs und den eng begrenzten OIDC-Callback aus", async () => {
    vi.stubEnv("BASE_URL", "/buchhaltung/");
    const send = vi.fn();
    for (const path of ["/buchhaltung/api/mcp", "/buchhaltung/api/v1/belege", "/buchhaltung/api/auth/callback/oidc"]) {
      expect(await guardVideomakerSession(request(path, ""), config, send)).toBeNull();
    }
    for (const [path, method] of [
      ["/buchhaltung/api/mcp/extra", "GET"],
      ["/buchhaltung/api/v10/belege", "GET"],
      ["/buchhaltung/api/auth/callback/oidc", "POST"],
      ["/buchhaltung/api/bank/callback", "GET"],
      ["/buchhaltung/api/belege/teilen", "POST"],
      ["/buchhaltung/setup", "GET"],
    ])
      expect((await guardVideomakerSession(request(path, "", method), config, send))?.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
});
