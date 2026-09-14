import { quoteJobArgument } from "./job-host-protocol.ts";

/** Normalize SRT-owned proxy URLs before optionally replacing the namespace shell. */
export function jobCommand(executable: string, args: readonly string[], replaceShell: boolean) {
  const numericProxyHosts = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "grpc_proxy",
    "GRPC_PROXY",
  ]
    .map((key) => `export ${key}="\${${key}/localhost/127.0.0.1}";`)
    .join(" ");
  return `${numericProxyHosts} ${replaceShell ? "exec " : ""}${[executable, ...args].map(quoteJobArgument).join(" ")}`;
}
