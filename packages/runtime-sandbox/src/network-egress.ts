import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";

// Conservative public-unicast policy, based on IANA special-purpose registries.
// Special-purpose exceptions are intentionally not granted implicitly.
const reserved = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  reserved.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  reserved.addSubnet(address, prefix, "ipv6");

export function isPublicEgressAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !reserved.check(address, "ipv4");
  return (
    family === 6 &&
    !address.includes("%") &&
    globalV6.check(address, "ipv6") &&
    !reserved.check(address, "ipv6")
  );
}

const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function endToEnd(headers: IncomingMessage["headers"]) {
  const excluded = new Set([
    ...hopHeaders,
    ...(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((entry) => entry.trim()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

/** One Job Host owns one upstream. It accepts HTTP and CONNECT from SRT;
 * SRT translates SOCKS into CONNECT. No TLS interception, credential injection,
 * redirects, environment proxy discovery, or DNS cache is performed here. */
export async function openNetworkEgress(allowedDomains: readonly string[]) {
  const allowed = new Set(allowedDomains);
  const token = randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from(`Basic ${Buffer.from(`job:${token}`).toString("base64")}`);
  const sockets = new Set<Socket>();
  let stopped = false;
  let deniedTargets = 0;
  let deniedAddresses = 0;
  let connected = 0;
  function authenticated(req: IncomingMessage): boolean {
    const actual = Buffer.from(req.headers["proxy-authorization"] ?? "");
    return actual.length === expectedAuth.length && timingSafeEqual(actual, expectedAuth);
  }
  function track(socket: Socket) {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    if (stopped) socket.destroy();
    return socket;
  }
  async function resolve(host: string, port: number, client: Socket) {
    if (stopped || client.destroyed) throw new Error("stopped");
    if (!allowed.has(`${host}:${port}`)) {
      deniedTargets++;
      throw new Error("denied");
    }
    // Check every answer, then dial a numeric IP; no second resolver invocation.
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (stopped || client.destroyed) throw new Error("stopped");
    const selected = addresses[0];
    if (!selected || addresses.some((entry) => !isPublicEgressAddress(entry.address))) {
      deniedAddresses++;
      throw new Error("denied");
    }
    return selected;
  }
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 10000 },
    (req, res) => {
      if (!authenticated(req)) {
        res.writeHead(407);
        res.end();
        return;
      }
      const timer = setTimeout(() => req.socket.destroy(), 10000);
      res.once("close", () => clearTimeout(timer));
      void (async () => {
        const url = new URL(req.url ?? "");
        if (url.protocol !== "http:" || url.username || url.password || url.hash)
          throw new Error("denied");
        const host = url.hostname;
        const port = Number(url.port || 80);
        const address = await resolve(host, port, req.socket);
        const upstream = httpRequest(
          {
            host: address.address,
            family: address.family,
            port,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            agent: false,
            headers: { ...endToEnd(req.headers), host: url.host },
          },
          (response) => {
            clearTimeout(timer);
            res.writeHead(response.statusCode ?? 502, endToEnd(response.headers));
            response.on("error", () => res.destroy());
            response.pipe(res);
          },
        );
        upstream.on("socket", (socket) => {
          track(socket);
          socket.once("connect", () => connected++);
        });
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.once("aborted", () => upstream.destroy());
        res.once("close", () => upstream.destroy());
        req.pipe(upstream);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(403, { "X-Himawari-Egress-Error": "target-denied" });
        res.end();
      });
    },
  );
  server.on("connection", (socket) => {
    if (sockets.size >= 128) {
      socket.destroy();
      return;
    }
    track(socket);
  });
  server.on("connect", (req, clientStream, head) => {
    const client = clientStream as Socket;
    if (!authenticated(req)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n");
      return;
    }
    const timer = setTimeout(() => client.destroy(), 10000);
    client.once("close", () => clearTimeout(timer));
    void (async () => {
      const match = /^([a-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(req.url ?? "");
      if (!match || Number(match[2]) > 65535) throw new Error("denied");
      const host = match[1];
      if (!host) throw new Error("denied");
      const port = Number(match[2]);
      const address = await resolve(host, port, client);
      const upstream = track(
        connect({ host: address.address, port, family: address.family, allowHalfOpen: true }),
      );
      client.once("close", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
      upstream.once("close", () => client.destroy());
      upstream.once("connect", () => {
        connected++;
        clearTimeout(timer);
        if (stopped || client.destroyed) {
          upstream.destroy();
          return;
        }
        client.allowHalfOpen = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    })().catch(() =>
      client.end(
        "HTTP/1.1 403 Forbidden\r\nX-Himawari-Egress-Error: target-denied\r\nConnection: close\r\n\r\n",
      ),
    );
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.on("error", () => {
    void close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("EGRESS_BIND_FAILED");
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    const draining = [...sockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.destroy();
        }),
    );
    closing = Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      ...draining,
    ]).then(() => {});
    return closing;
  }
  const url = `http://job:${token}@127.0.0.1:${address.port}`;
  return Object.freeze({
    parentProxy: Object.freeze({ http: url, https: url, noProxy: "" }),
    close,
    observation: () => ({
      deniedTargets,
      deniedAddresses,
      connected,
      closed: stopped && sockets.size === 0,
    }),
  });
}
