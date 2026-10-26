import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, buildConnector, type Dispatcher } from "undici";

function denied(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export function createPublicWebDispatcher(input: {
  readonly allowedTargets: readonly string[];
  readonly isPublicAddress: (address: string) => boolean;
}): Dispatcher {
  const allowed = new Set(input.allowedTargets);
  const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, "");
        return;
      }
      if (!addresses.length || addresses.some(({ address }) => !input.isPublicAddress(address))) {
        callback(denied("WEB_EGRESS_ADDRESS_DENIED"), "");
        return;
      }
      const usable = options.family
        ? addresses.filter(({ family }) => family === options.family)
        : addresses;
      const first = usable[0];
      if (!first) {
        callback(denied("WEB_EGRESS_ADDRESS_DENIED"), "");
        return;
      }
      if (options.all) callback(null, usable);
      else callback(null, first.address, first.family);
    });
  };
  const connect = buildConnector({ lookup: publicOnlyLookup });
  return new Agent({
    connect: (options, callback) => {
      if (
        options.protocol !== "https:" ||
        !allowed.has(`${options.hostname}:${options.port || "443"}`)
      ) {
        callback(denied("WEB_EGRESS_TARGET_DENIED"), null);
        return;
      }
      connect(options, callback);
    },
  });
}
