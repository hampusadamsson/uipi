// Regression: `S2CBase.id` is the transport's correlation id — the client stamps
// it onto the outgoing frame and this server echoes it back. The config document
// field is therefore `docId`, not `id`, so a correlated config request must still
// resolve the document the caller named instead of the correlation id.
//
// Runs over a real WebSocket against a service seeded with one live session whose
// agentDir is a mkdtemp directory: the real ~/.pi/agent is never touched.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { C2S, S2C } from "@uipi/protocol";
import { createServer } from "../src/transport.js";
import { SessionService } from "../src/sessions.js";
import type { Subscriber } from "../src/types.js";

let httpServer: import("node:http").Server;
let agentDir: string;
let port = 0;

beforeAll(async () => {
  agentDir = mkdtempSync(join(tmpdir(), "uipi-config-transport-"));
  writeFileSync(join(agentDir, "settings.json"), '{"theme":"dark"}\n');
  writeFileSync(join(agentDir, "roles.json"), '{\n  "work": {}\n}\n');

  const svc = new SessionService(undefined as never);
  // config routes run against the agent dir of the first live session
  (svc as unknown as { live: Map<string, unknown> }).live.set("s1", {
    id: "s1",
    cwd: agentDir,
    agentDir,
    subscribers: new Map<Subscriber, true>(),
  });

  httpServer = createServer({ port: 0 }, svc).httpServer;
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  httpServer.close();
  rmSync(agentDir, { recursive: true, force: true });
});

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<S2C & { id?: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(String(raw)));
    });
  });
}

describe("config requests over the correlated transport", () => {
  it("resolves the intended document when the frame also carries a correlation id", async () => {
    const ws = await connect();
    // exactly what Conn.request sends: the payload plus a transport `id`
    const frame: C2S & { id: string } = { type: "proto.configGet", docId: "roles", id: "r42" };
    ws.send(JSON.stringify(frame));

    const reply = await nextMessage(ws);
    ws.close();

    // the correlation id came back untouched…
    expect(reply.id).toBe("r42");
    // …and the server read the *document* id, not the correlation id
    expect(reply.type).toBe("proto.configGet");
    const doc = (reply as Extract<S2C, { type: "proto.configGet" }>).doc;
    expect(doc.docId).toBe("roles");
    expect(doc.text).toBe('{\n  "work": {}\n}\n');
  });

  it("resolves the intended document for a correlated configUpdate", async () => {
    const ws = await connect();
    const read = await (async () => {
      ws.send(JSON.stringify({ type: "proto.configGet", docId: "settings", id: "r1" }));
      return nextMessage(ws);
    })();
    const mtimeMs = (read as Extract<S2C, { type: "proto.configGet" }>).doc.mtimeMs;

    ws.send(
      JSON.stringify({
        type: "proto.configUpdate",
        docId: "settings",
        mtimeMs,
        text: '{"theme":"light"}\n',
        id: "r2",
      }),
    );
    const reply = await nextMessage(ws);
    ws.close();

    expect(reply.id).toBe("r2");
    expect(reply.type).toBe("proto.configUpdate");
    const doc = (reply as Extract<S2C, { type: "proto.configUpdate" }>).doc;
    expect(doc.docId).toBe("settings");
    expect(doc.text).toBe('{"theme":"light"}\n');
  });
});
