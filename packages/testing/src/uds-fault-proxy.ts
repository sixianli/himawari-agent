import http from "node:http";

export async function udsFaultProxy(
  socketPath: string,
  target: string,
  observe?: (path: string, body: Buffer) => void,
) {
  let dropPath: string | undefined;
  let dropBody: ((body: Buffer) => boolean) | undefined;
  let releaseHandshake: (() => void) | undefined;
  let handshakeGate: Promise<void> | undefined;
  let denyHandshake = false;
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    const url = request.url ?? "/";
    requests.push(url);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    observe?.(url, body);
    if (dropPath === url && (!dropBody || dropBody(body))) {
      dropPath = undefined;
      response.destroy();
      return;
    }
    if (url.endsWith("/handshake")) {
      await handshakeGate;
      if (denyHandshake) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "TEST_PEER_REJECTED" }));
        return;
      }
    }
    const upstream = http.request(
      { socketPath: target, method: request.method, path: url, headers: request.headers },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 500, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    upstream.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    requests,
    dropNext(path: string, matchesBody?: (body: Buffer) => boolean) {
      dropPath = path;
      dropBody = matchesBody;
    },
    blockHandshakes(deny = false) {
      denyHandshake = deny;
      handshakeGate = new Promise<void>((resolve) => {
        releaseHandshake = resolve;
      });
    },
    releaseHandshakes() {
      releaseHandshake?.();
    },
    async close() {
      releaseHandshake?.();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
