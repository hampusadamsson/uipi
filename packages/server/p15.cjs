const WebSocket = require("ws");
const fs = require("fs");
const ws = new WebSocket("ws://127.0.0.1:8787/ws");
const out = [];
ws.on("open", () => {
  out.push("OPEN");
  ws.send(JSON.stringify({ type: "proto.newSession", cwd: "/tmp/uipi-probeZ" }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "proto.attached") {
    out.push("ATTACHED " + m.sessionId);
    ws.send(JSON.stringify({ type: "pi.setModel", sessionId: m.sessionId, provider: "bifrost", modelId: "qwen3.6-27b", id: "s1" }));
  } else if (m.type === "proto.modelSet") {
    out.push("MODELSET " + JSON.stringify(m.model));
    // only now send the prompt — proves ordering
    ws.send(JSON.stringify({ type: "pi.prompt", sessionId: m.sessionId, text: "Say hi and nothing else.", id: "p1" }));
  } else if (m.type === "pi.evt") {
    out.push("EVT " + m.event?.type + " " + (m.event?.assistantMessageEvent?.type ?? "") + " " + (m.event?.message?.role ?? ""));
  } else if (m.type !== "proto.sessions") {
    out.push("MSG " + JSON.stringify(m).slice(0, 200));
  }
});
setTimeout(() => {
  fs.writeFileSync("/tmp/p15.log", out.join("\n"));
  process.exit(0);
}, 40000);
