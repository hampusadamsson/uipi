const WebSocket = require("ws");
const fs = require("fs");
const ws = new WebSocket("ws://127.0.0.1:8787/ws");
const out = [];
ws.on("open", () => ws.send(JSON.stringify({ type: "proto.newSession", cwd: "/tmp/uipi-probeU" })));
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "proto.attached") {
    out.push("A");
    ws.send(JSON.stringify({ type: "proto/listModels", id: "m1" }));
  } else if (m.type === "proto.models") {
    const q = m.models.find((x) => /qwen3.6-27b/.test(x.modelId));
    out.push("MODELS " + m.models.length);
    ws.send(JSON.stringify({ type: "pi.setModel", sessionId: m.sessionId, provider: q.provider, modelId: q.modelId, id: "s1" }));
  } else if (m.type === "proto.modelSet") {
    out.push("MODELSET");
    ws.send(JSON.stringify({ type: "pi.prompt", sessionId: m.sessionId, text: "Count 1 to 3 then stop.", id: "pp" }));
  } else if (m.type === "pi.evt") {
    if (["agent_start","agent_end","agent_settled","turn_end"].includes(m.event?.type) || m.event?.assistantMessageEvent?.type)
      out.push("EVT " + m.event?.type + " " + (m.event?.assistantMessageEvent?.type ?? ""));
  } else if (m.type !== "proto.sessions") {
    out.push("MSG " + JSON.stringify(m).slice(0, 150));
  }
});
const done = () => { fs.writeFileSync("/tmp/p18.log", out.join("\n")); process.exit(0); };
setTimeout(done, 50000);
process.on("SIGINT", done);
