import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** A transport must connect only to address, preserving the URL's HTTP/TLS identity. */
export interface PublicWebTransport {
  request(input: {
    readonly url: string;
    readonly address: string;
    readonly signal: AbortSignal;
  }): Promise<Response>;
}

export class NodePublicWebTransport implements PublicWebTransport {
  request(input: Parameters<PublicWebTransport["request"]>[0]): Promise<Response> {
    const url = new URL(input.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(input.address);
    if (
      !family ||
      (isIP(hostname) && hostname !== input.address) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return Promise.reject(new Error("WEB_TRANSPORT_TARGET_INVALID"));
    }
    return new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "GET",
          agent: false,
          signal: input.signal,
          // Keep hostname/SNI/certificate validation on the original URL. DNS is
          // replaced with the already authorized address, including lookup-all.
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address: input.address, family }]);
            else callback(null, input.address, family);
          },
          headers: {
            accept: "text/html,text/plain,application/json;q=0.9",
            "accept-encoding": "identity",
            "user-agent": "Himawari-Agent-Public-Research/0.2",
          },
        },
        (incoming) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
          }
          const status = incoming.statusCode ?? 502;
          if ([204, 205, 304].includes(status)) {
            incoming.destroy();
            resolve(new Response(null, { status, headers }));
          } else {
            resolve(
              new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
                status,
                headers,
              }),
            );
          }
        },
      );
      request.on("error", reject);
      request.end();
    });
  }
}

export class NodePublicHostResolver {
  async resolve(hostname: string): Promise<readonly string[]> {
    const literal = hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal)) return [literal];
    return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
  }
}
