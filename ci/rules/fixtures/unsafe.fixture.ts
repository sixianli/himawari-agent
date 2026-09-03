import child_process from "node:child_process";

export function unsafe(input: string) {
  // ruleid: himawari.dynamic-code-evaluation
  eval(input);
  // ruleid: himawari.dynamic-code-evaluation
  const evaluate = new Function(input);
  // ruleid: himawari.disabled-tls-verification
  const tls = { rejectUnauthorized: false };
  // ruleid: himawari.disabled-tls-verification
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  // ruleid: himawari.dynamic-shell-command
  child_process.exec(input);
  return { evaluate, tls };
}
