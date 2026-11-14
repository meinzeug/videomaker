import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { guardVideomakerSession } from "./videomaker-session.ts";

vi.mock("./videomaker-session-binding.ts", () => ({ currentVideomakerReference: async () => null }));

const request = () => new Request("http://localhost:3199/buchhaltung/setup", { headers: { cookie: "kontrakurs_session=12345.test.signature" } });
const secret = "synthetischer-testschluessel-nicht-produktiv";
let scratch: string;
let caFile: string;
let otherCaFile: string;
let good: { key: Buffer; cert: Buffer };
let wrongName: { key: Buffer; cert: Buffer };

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: scratch, stdio: "ignore" });
}
function cert(name: string, dns: string, serial: string) {
  openssl(
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${dns}`,
    "-addext",
    `subjectAltName=DNS:${dns}`,
  );
  openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-set_serial",
    serial,
    "-days",
    "1",
    "-copy_extensions",
    "copy",
    "-out",
    `${name}.pem`,
  );
  return { key: readFileSync(join(scratch, `${name}.key`)), cert: readFileSync(join(scratch, `${name}.pem`)) };
}
async function listen(server: HttpsServer | ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Testport fehlt");
  return address.port;
}
const config = (port: number, ca = caFile) => ({
  mode: "required",
  endpoint: `https://127.0.0.1:${port}/api/internal/buchhaltung/session`,
  secret,
  caFile: ca,
});

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "haben-sitzung-tls-"));
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Haben test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  );
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "other.key",
    "-out",
    "other.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Other test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  );
  caFile = join(scratch, "ca.pem");
  otherCaFile = join(scratch, "other.pem");
  chmodSync(caFile, 0o644);
  chmodSync(otherCaFile, 0o644);
  good = cert("good", "videomaker-session.internal", "1");
  wrongName = cert("wrong", "other.internal", "2");
}, 30_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("Authentifizierte Video-Maker-Gegenstelle", () => {
  it("sendet die gebundene Referenz ausschließlich über den verifizierten TLS-Endpunkt", async () => {
    const reference = "a".repeat(43), bindingSecret = "b".repeat(32);
    let checked = false;
    const server = createHttpsServer(good, (req, res) => {
      checked = req.method === "POST" && req.url === "/api/internal/oidc/session-binding" &&
        req.headers["x-oidc-binding-operation"] === "match" && req.headers["x-oidc-session-reference"] === reference &&
        req.headers["x-videomaker-internal-secret"] === bindingSecret && req.headers.cookie === "kontrakurs_session=12345.test.signature";
      res.writeHead(204).end();
    });
    const port = await listen(server);
    try {
      expect(await guardVideomakerSession(request(), { ...config(port), bindingSecret }, undefined, async () => reference)).toBeNull();
      expect(checked).toBe(true);
    } finally { server.close(); }
  });
  it("erlaubt nur den passenden Server und prüft jede Sitzung neu", async () => {
    let count = 0;
    const server = createHttpsServer(good, (req, res) => {
      expect(req.headers.cookie).toBe("kontrakurs_session=12345.test.signature");
      expect(req.headers["x-videomaker-internal-secret"]).toBe(secret);
      res.writeHead(++count === 1 ? 204 : 401).end();
    });
    const port = await listen(server);
    try {
      expect(await guardVideomakerSession(request(), config(port))).toBeNull();
      expect((await guardVideomakerSession(request(), config(port)))?.status).toBe(401);
      expect(count).toBe(2);
    } finally {
      server.close();
    }
  });

  it("verweigert fremde CA und falschen Zertifikatsnamen, ohne Cookie oder Secret preiszugeben", async () => {
    let received = 0;
    const validServer = createHttpsServer(good, (_req, res) => {
      received++;
      res.writeHead(204).end();
    });
    const wrongServer = createHttpsServer(wrongName, (_req, res) => {
      received++;
      res.writeHead(204).end();
    });
    const port = await listen(validServer);
    const wrongPort = await listen(wrongServer);
    try {
      expect((await guardVideomakerSession(request(), config(port, otherCaFile)))?.status).toBe(503);
      expect((await guardVideomakerSession(request(), config(wrongPort)))?.status).toBe(503);
      expect(received).toBe(0);
    } finally {
      validServer.close();
      wrongServer.close();
    }
  });

  it("verweigert fehlende CA-Datei, Verbindungsfehler und einen hängenden TLS-Handshake", async () => {
    const hanging = createTcpServer(() => {});
    const port = await listen(hanging);
    try {
      expect((await guardVideomakerSession(request(), config(port, join(scratch, "fehlt.pem"))))?.status).toBe(503);
      expect((await guardVideomakerSession(request(), config(port)))?.status).toBe(503);
    } finally {
      hanging.close();
    }
    expect((await guardVideomakerSession(request(), config(port)))?.status).toBe(503);
  }, 10_000);

  it("verweigert FIFO, Gerät, Symlink, veränderbare und übergroße CA-Dateien ohne Serveranfrage", async () => {
    let received = 0;
    const server = createHttpsServer(good, (_req, res) => {
      received++;
      res.writeHead(204).end();
    });
    const port = await listen(server);
    const fifo = join(scratch, "fifo");
    const symlink = join(scratch, "link.pem");
    const large = join(scratch, "large.pem");
    const writable = join(scratch, "writable.pem");
    execFileSync("mkfifo", [fifo]);
    symlinkSync(caFile, symlink);
    writeFileSync(large, Buffer.alloc(64 * 1024 + 1));
    writeFileSync(writable, readFileSync(caFile));
    chmodSync(writable, 0o666);
    try {
      for (const path of [fifo, "/dev/zero", symlink, large, writable, scratch]) {
        expect((await guardVideomakerSession(request(), config(port, path)))?.status).toBe(503);
      }
      expect(received).toBe(0);
    } finally {
      server.close();
    }
  }, 10_000);

  const uid = process.geteuid?.();
  it.skipIf(uid === undefined || uid === 0)("verweigert eine nicht vom Dienstbenutzer oder root besessene CA", async () => {
    let received = 0;
    const server = createHttpsServer(good, (_req, res) => {
      received++;
      res.writeHead(204).end();
    });
    const port = await listen(server);
    const owner = vi.spyOn(process, "geteuid").mockReturnValue(uid! + 1);
    try {
      expect((await guardVideomakerSession(request(), config(port)))?.status).toBe(503);
      expect(received).toBe(0);
    } finally {
      owner.mockRestore();
      server.close();
    }
  });
});
