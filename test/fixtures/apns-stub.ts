import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import type { ApplePushEnvironment } from "@himawari-agent/application";

export interface ApnsStubRequest {
  readonly headers: IncomingHttpHeaders;
  readonly path: string;
  readonly token: string;
  readonly body: string;
  readonly json: Record<string, unknown>;
}

export interface ApnsStub {
  readonly requests: ApnsStubRequest[];
  readonly origins: Readonly<Record<ApplePushEnvironment, string>>;
  readonly signingKeyPem: Uint8Array;
  readonly publicKey: KeyObject;
  respond: (request: ApnsStubRequest) => { readonly status: number; readonly reason?: string };
  ofType(pushType: string): ApnsStubRequest[];
  close(): Promise<void>;
}

export async function startApnsStub(): Promise<ApnsStub> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const requests: ApnsStubRequest[] = [];
  const stub: ApnsStub = {
    requests,
    origins: { development: "", production: "" },
    signingKeyPem: new Uint8Array(
      Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string),
    ),
    publicKey,
    respond: () => ({ status: 200 }),
    ofType: (pushType) => requests.filter(({ headers }) => headers["apns-push-type"] === pushType),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
  const server: Http2Server = createServer();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = String(headers[":path"]);
      const request: ApnsStubRequest = {
        headers,
        path,
        token: path.slice("/3/device/".length),
        body,
        json: JSON.parse(body) as Record<string, unknown>,
      };
      requests.push(request);
      const answer = stub.respond(request);
      stream.respond({ ":status": answer.status, "content-type": "application/json" });
      stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (stub as { origins: ApnsStub["origins"] }).origins = { development: origin, production: origin };
  return stub;
}
