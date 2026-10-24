import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createServer } from "../src/transport.js";
import { SessionService } from "../src/sessions.js";

let port = 0;
let httpServer: import("node:http").Server;

beforeAll(async () => {
  const svc = new SessionService(
    // stub runtime factory — never called in these tests
    undefined as never
  );
  const created = createServer({ port: 0 }, svc);
  httpServer = created.httpServer;
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  httpServer.close();
});

function connect(p: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(String(raw)));
    });
  });
}

function jsonSend(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

describe("uipi server transport", () => {
  it("replies with an error for unknown message types", async () => {
    const ws = await connect(port);
    jsonSend(ws, { id: "r1", type: "bogus.command" });
    const reply = await nextMessage(ws);
    expect(reply.type).toBe("proto.error");
    expect(reply.id).toBe("r1");
    ws.close();
  });

  it("replies to proto.listSessions", async () => {
    const ws = await connect(port);
    jsonSend(ws, { id: "r2", type: "proto.listSessions" });
    const reply = await nextMessage(ws);
    expect(reply.type).toBe("proto.sessions");
    expect(Array.isArray(reply.sessions)).toBe(true);
    ws.close();
  }, 30000);

  it("returns recent dirs", async () => {
    const ws = await connect(port);
    jsonSend(ws, { id: "r3", type: "proto/recentDirs" });
    const reply = await nextMessage(ws);
    expect(reply.type).toBe("proto.recentDirs");
    ws.close();
  });

  it("errors on unknown session command", async () => {
    const ws = await connect(port);
    jsonSend(ws, { id: "r4", type: "pi.abort", sessionId: "does-not-exist" });
    const reply = await nextMessage(ws);
    expect(reply.type).toBe("proto.error");
    expect(reply.message).toContain("no such live session");
    ws.close();
  });

  it("errors on attach to unknown session", async () => {
    const ws = await connect(port);
    jsonSend(ws, { id: "r5", type: "proto.attach", sessionId: "does-not-exist" });
    const reply = await nextMessage(ws);
    expect(reply.type).toBe("proto.error");
    expect(reply.message).toContain("no such session");
    ws.close();
  });
});
