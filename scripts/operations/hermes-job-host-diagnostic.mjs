// Synthetic qualification only: observe existing child stderr without changing arguments or behavior.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const original = childProcess.fork;
childProcess.fork = function (...args) {
  const child = original.apply(this, args);
  let pending = "";
  child.stderr?.on("data", (bytes) => {
    pending = (pending + bytes.toString("utf8")).slice(-8192);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (/^JOB_HOST_[A-Z0-9_]{1,100}$/.test(line.trim()))
        process.stderr.write(`QUALIFICATION_DIAGNOSTIC:${line.trim()}\n`);
    }
  });
  return child;
};
syncBuiltinESMExports();
