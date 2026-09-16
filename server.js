const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const agentUrl = process.env.AGENT_URL || "http://ntp.local:8081/status";
const agentTimeoutMs = 5000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/status", async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), agentTimeoutMs);
  try {
    const agentRes = await fetch(agentUrl, { signal: controller.signal });
    if (!agentRes.ok) {
      throw new Error(`agent responded with ${agentRes.status}`);
    }
    const data = await agentRes.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `could not reach ntp.local agent: ${err.message}` });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(port, () => {
  console.log(`gpsdash listening on port ${port}`);
});

module.exports = app;
