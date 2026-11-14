import { afterEach, describe, expect, it, vi } from "vitest";
import { guardVideomakerSession } from "./videomaker-session.ts";

vi.mock("./videomaker-session-binding.ts", () => ({ currentVideomakerReference: async () => null }));

const config = { mode: "required", endpoint: "https://127.0.0.1:3000/api/internal/buchhaltung/session", secret: "s".repeat(32), caFile: "/tmp/ca.pem" };
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
      { ...config, caFile: undefined },
      { ...config, caFile: "relative.pem" },
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
    const send = vi.fn(async () => 204);
    expect(await guardVideomakerSession(request("/buchhaltung/belege", "haben=privat; kontrakurs_session=12345.test.signature"), config, send)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(url).toBe(config.endpoint);
    expect(init).toEqual({ cookie: "kontrakurs_session=12345.test.signature", secret: config.secret, caFile: config.caFile });
  });

  it("prüft für eine Haben-Sitzung die konkrete Referenz mit dem aktuellen Video-Maker-Cookie", async () => {
    const reference = "a".repeat(43);
    const boundConfig = { ...config, bindingSecret: "b".repeat(32) };
    const send = vi.fn(async () => 204);
    expect(await guardVideomakerSession(request(), boundConfig, send, async () => reference)).toBeNull();
    expect(send).toHaveBeenCalledWith("https://127.0.0.1:3000/api/internal/oidc/session-binding", {
      cookie: "kontrakurs_session=12345.test.signature", secret: boundConfig.bindingSecret, caFile: config.caFile, reference,
    });
    expect((await guardVideomakerSession(request(), boundConfig, async () => 401, async () => reference))?.status).toBe(401);
    expect((await guardVideomakerSession(request(), boundConfig, send, async () => ""))?.status).toBe(401);
    expect((await guardVideomakerSession(request(), config, send, async () => reference))?.status).toBe(503);
    expect((await guardVideomakerSession(request(), boundConfig, send, async () => { throw new Error("db"); }))?.status).toBe(503);
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
    const send = vi.fn().mockResolvedValueOnce(204).mockResolvedValueOnce(401);
    expect(await guardVideomakerSession(request(), config, send)).toBeNull();
    expect((await guardVideomakerSession(request(), config, send))?.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("begrenzt parallele Prüfungen ohne Warteschlange und gibt Plätze wieder frei", async () => {
    const release: Array<() => void> = [];
    const send = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release.push(() => resolve(204));
        }),
    );
    const requests: Array<Promise<Response | null>> = [];
    for (let group = 0; group < 8; group++) {
      requests.push(guardVideomakerSession(request(), config, send), guardVideomakerSession(request(), config, send));
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes((group + 1) * 2));
    }
    expect((await guardVideomakerSession(request(), config, send))?.status).toBe(503);
    for (const finish of release) finish();
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 16 }, () => null));
    expect(await guardVideomakerSession(request(), config, async () => 204)).toBeNull();
  });

  it("begrenzt hängende Lookups auch nach dem Timeout und gibt Plätze erst nach tatsächlichem Ende frei", async () => {
    const releases: Array<() => void> = [];
    const lookup = vi.fn(() => new Promise<null>((resolve) => releases.push(() => resolve(null))));
    const send = vi.fn(async () => 204);
    const first = guardVideomakerSession(request(), config, send, lookup);
    const second = guardVideomakerSession(request(), config, send, lookup);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect((await guardVideomakerSession(request(), config, send, lookup))?.status).toBe(503);
    expect((await first)?.status).toBe(503);
    expect((await second)?.status).toBe(503);
    expect((await guardVideomakerSession(request(), config, send, lookup))?.status).toBe(503);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    releases.forEach((release) => release());
    await vi.waitFor(async () => expect(await guardVideomakerSession(request(), config, send, async () => null)).toBeNull());
  }, 10_000);

  it("schließt bei Ausfällen, Weiterleitungen und unerwarteten Antworten", async () => {
    for (const send of [
      async () => {
        throw new Error("Netzfehler");
      },
      async () => 302,
      async () => 200,
      async () => 503,
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
