import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:8787/ws");
let id = 0;
const log = (t, m) => console.log(`[${t}]`, JSON.stringify(m).slice(0, 220));
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "proto.newSession", cwd: "/tmp/uipi-probe" }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "proto.attached") {
    log("attached", { sessionId: m.sessionId });
    ws.send(JSON.stringify({ type: "pi.setModel", sessionId: m.sessionId, provider: "bifrost", modelId: "qwen3.6-27b" }));
    setTimeout(() => ws.send(JSON.stringify({ type: "pi.prompt", sessionId: m.sessionId, text: "Count from 1 to 3 and stop." })), 800);
    setTimeout(() => process.exit(0), 15000);
  } else {
    log(m.type, m);
  }
});
