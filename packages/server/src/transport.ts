import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { C2S, S2C } from "@uipi/protocol";
import { SessionService } from "./sessions.js";
import type { Subscriber } from "./types.js";

export interface ServerOptions {
  port: number;
  /** Directory with built web assets (prod). If missing, only WS. */
  staticDir?: string;
}

export function createServer(opts: ServerOptions, service: SessionService) {
  const staticDir = opts.staticDir ?? "";
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (!staticDir) {
      res.writeHead(404).end("uipi: no static assets built. Run `pnpm -r build`.");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname: string = url.pathname ?? "/";
    const file: string = pathname === "/" ? "/index.html" : pathname;
    const resolved = path.join(staticDir, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (!resolved.startsWith(staticDir)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        // SPA fallback
        fs.readFile(path.join(staticDir, "index.html"), (e2, index) => {
          if (e2) {
            res.writeHead(404).end("not found");
            return;
          }
          res.writeHead(200, { "content-type": "text/html" }).end(index);
        });
        return;
      }
      const ext = path.extname(resolved);
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, { "content-type": mime[ext] ?? "application/octet-stream" }).end(data);
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const clients = new Set<Subscriber>();
  // session lifecycle changes (new/open/detach) broadcast to every connected client
  service.broadcast = (msg) => {
    for (const c of clients) {
      try {
        c.send(msg);
      } catch {
        /* dead socket */
      }
    }
  };

  wss.on("connection", (socket: WebSocket) => {
    const sub: Subscriber = {
      send: (msg: S2C) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      },
    };
    clients.add(sub);
    socket.on("message", (raw: unknown) => {
      let msg: C2S & { id?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        sub.send({ type: "proto.error", message: "invalid json" });
        return;
      }
      const reply: typeof sub.send = (m) =>
        sub.send(
          (msg.id !== undefined ? { ...m, id: msg.id } : m) as S2C
        );
      try {
    if ("sessionId" in msg && msg.type.startsWith("pi.")) {
          void service.handleSessionCmd(msg, reply);
        } else {
          void service.handle(msg, reply, sub);
        }
      } catch (e) {
        sub.send({ type: "proto.error", message: String(e) });
      }
    });
    socket.on("close", () => {
      clients.delete(sub);
      // subscriber is dropped; live sessions keep running
    });
  });

  return { httpServer, wss };
}
