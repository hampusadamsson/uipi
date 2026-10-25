const WebSocket = require("ws");
const fs = require("fs");
const ws = new WebSocket("ws://127.0.0.1:8787/ws");
const out = [];
ws.on("open", () => {
  out.push("OPEN");
  ws.send(JSON.stringify({ type: "proto.newSession", cwd: "/tmp/uipi-probeW" }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "proto.attached") {
    out.push("ATTACHED ok");
    ws.send(JSON.stringify({ type: "proto/listModels", id: "m1" }));
  } else if (m.type === "proto.models") {
    const q = m.models.find((x) => /qwen3.6-27b/.test(x.modelId));
    ws.send(JSON.stringify({ type: "pi.setModel", sessionId: m.sessionId, provider: q.provider, modelId: q.modelId, id: "s1" }));
  } else if (m.type === "proto.modelSet") {
    out.push("MODELSET " + JSON.stringify(m.model));
    ws.send(JSON.stringify({ type: "pi.prompt", sessionId: m.sessionId, text: "Count 1 to 3 then stop." }));
  } else if (m.type === "pi.evt") {
    out.push("EVT " + m.event?.type + " " + (m.event?.assistantMessageEvent?.type ?? "") + " " + (m.event?.message?.role ?? "") + " stop:" + (m.event?.message?.stopReason ?? ""));
  } else if (m.type !== "proto.sessions") {
    out.push("MSG " + JSON.stringify(m).slice(0, 160));
  }
});
setTimeout(() => {
  fs.writeFileSync("/tmp/p16.log", out.join("\n"));
  process.exit(0);
}, 45000);
