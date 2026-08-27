import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const staticRoot = path.join(repositoryRoot, "apps/control-center/dist");
const port = Number(process.env.HIMAWARI_BROWSER_FIXTURE_PORT ?? "4173");
const now = "2026-08-27T00:00:00.000Z";
const accepted = new Set();
let cursorSequence = 1;
let healthDegraded = false;

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function envelope(kind, type) {
  return {
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `${kind}:${type}:fixture`,
    correlationId: "correlation:fixture",
    causationId: "message:fixture",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: { ownerId: "owner-01", agentId: "agent-01" },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "system-01" },
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function collectionCategory(type) {
  return {
    "thread.list": ["threads", ["thread-main", "thread-research"]],
    "thread.timeline": ["messages", ["message-01", "message-02"]],
    "approval.list": ["approvals", ["approval-01"]],
    "task.list": ["tasks", ["job-repository-monitor", "job-daily-review"]],
    "inbox.list": ["inbox", ["inbox-01"]],
    "memory.search": ["memories", ["memory-01", "memory-02"]],
    "trace.timeline": ["trace", ["trace-01", "trace-02"]],
    "identity.sessions": ["sessions", ["session-01", "device-01"]],
  }[type];
}

function contentType(filePath) {
  switch (path.extname(filePath)) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html; charset=utf-8";
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/api/control-center/v1/config") {
    json(response, 200, {
      ownerId: "owner-01",
      agentId: "agent-01",
      deploymentId: "deployment-01",
      authorityEpoch: 1,
      fencingToken: 1,
      actorId: "owner-01",
      csrfToken: "csrf-fixture",
      primaryModel: { provider: "fixture-provider", model: "fixture-primary", version: "v1" },
      primaryModelRef: "model:fixture-primary:v1",
      repositoryAllowlistRefs: ["fixture-owner/fixture-repository"],
      disclosedDataClassifications: ["private"],
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__fixture/degrade") {
    healthDegraded = true;
    json(response, 200, { degraded: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/gateway/v2/queries") {
    const message = await body(request);
    if (message.type === "health.status") {
      json(response, 200, {
        ...envelope("snapshot", "health.snapshot"),
        payload: {
          deploymentId: "deployment-01",
          activeHost: "browser-fixture",
          authorityEpoch: 1,
          live: true,
          ready: !healthDegraded,
          status: healthDegraded ? "degraded" : "healthy",
          componentRefs: ["sqlite", "worker", "identity"],
          generatedAt: now,
        },
      });
      return;
    }
    const [category, itemRefs] = collectionCategory(message.type) ?? ["threads", []];
    json(response, 200, {
      ...envelope("snapshot", "collection.snapshot"),
      payload: {
        category,
        itemRefs,
        nextCursor: null,
        snapshotRef: `snapshot:${category}`,
        generatedAt: now,
      },
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/payload/v1/text") {
    const message = await body(request);
    const digest = createHash("sha256").update(message.content).digest("hex").slice(0, 24);
    json(response, 201, { payloadRef: `payload:${digest}` });
    return;
  }
  if (
    request.method === "POST" &&
    (url.pathname === "/api/gateway/v2/commands" || url.pathname === "/api/gateway/v1/commands")
  ) {
    const message = await body(request);
    const replayed = accepted.has(message.idempotencyKey);
    accepted.add(message.idempotencyKey);
    json(response, 200, { resultRef: `accepted:${message.type}`, replayed });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/gateway/v2/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const timer = setInterval(() => response.write(": heartbeat\n\n"), 1000);
    const eventTimer = setTimeout(() => {
      cursorSequence += 1;
      const event = {
        ...envelope("event", "stream.event"),
        messageId: `event:${cursorSequence}`,
        payload: {
          cursor: `cursor-${cursorSequence}`,
          retentionStartCursor: "cursor-01",
          eventId: `event-${cursorSequence}`,
          scopeKind: "run",
          scopeId: "run-01",
          sequence: cursorSequence,
          occurredAt: now,
          eventType: "run.completed",
          payloadRef: null,
        },
      };
      response.write(
        `id: cursor-${cursorSequence}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }, 100);
    request.on("close", () => {
      clearInterval(timer);
      clearTimeout(eventTimer);
    });
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const target = path.resolve(staticRoot, relative);
  if (
    !target.startsWith(`${staticRoot}${path.sep}`) &&
    target !== path.join(staticRoot, "index.html")
  ) {
    response.writeHead(404).end();
    return;
  }
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    const fallback = await readFile(path.join(staticRoot, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fallback);
    return;
  }
  response.writeHead(200, { "content-type": contentType(target) });
  createReadStream(target).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`CONTROL_CENTER_FIXTURE_READY http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
