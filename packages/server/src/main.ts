import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { SessionService } from "./sessions.js";
import { createServer } from "./transport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.UIPI_PORT ?? 8787);
const HOST = process.env.UIPI_HOST ?? "127.0.0.1";
const staticDir = process.env.UIPI_STATIC
  ? path.resolve(process.env.UIPI_STATIC)
  : path.resolve(here, "../../web/dist");

const service = new SessionService(createAgentSessionRuntime);
const { httpServer } = createServer({ port: PORT, staticDir: staticDir }, service);

const shutdown = async () => {
  await service.shutdown();
  httpServer.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

httpServer.listen(PORT, HOST, () => {
  console.log(`uipi server → http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}  (ws /ws)`);
});
