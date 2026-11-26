import { randomBytes } from "node:crypto";
import { openNetworkEgress } from "../network-egress.ts";

const HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizeAllowedDomains(domains: readonly string[]): readonly string[] {
  const targets = new Set<string>();
  for (const raw of domains) {
    const entry = raw.trim().toLowerCase();
    const match = /^([^:]+)(?::([1-9][0-9]{0,4}))?$/.exec(entry);
    const host = match?.[1];
    const port = match?.[2] ? Number(match[2]) : null;
    if (!host || !HOST.test(host) || (port !== null && port > 65535))
      throw new Error(`COMPUTER_DOMAIN_INVALID: ${raw}`);
    if (port === null) {
      targets.add(`${host}:443`);
      targets.add(`${host}:80`);
    } else targets.add(`${host}:${port}`);
  }
  return [...targets].sort();
}

export class CallAllowlist {
  private readonly calls = new Map<number, readonly string[]>();
  private next = 0;

  open(targets: readonly string[]): () => void {
    const id = this.next++;
    this.calls.set(id, targets);
    return () => {
      this.calls.delete(id);
    };
  }

  allows(target: string): boolean {
    for (const targets of this.calls.values()) if (targets.includes(target)) return true;
    return false;
  }
}

export interface ComputerEgress {
  readonly proxyUrl: string;
  readonly allowlist: CallAllowlist;
  close(): Promise<void>;
}

export async function openComputerEgress(host: string): Promise<ComputerEgress> {
  const allowlist = new CallAllowlist();
  const egress = await openNetworkEgress(
    (target) => allowlist.allows(target),
    async () => {},
    { host, port: 0, token: randomBytes(32).toString("hex") },
  );
  return Object.freeze({
    proxyUrl: egress.parentProxy.http,
    allowlist,
    close: () => egress.close(),
  });
}
