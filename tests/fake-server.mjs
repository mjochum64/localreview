import http from "node:http";

export async function startFakeServer(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      handler({ req, res, body });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

export function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export function sendSse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }
  res.end();
}
