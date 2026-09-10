import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { jobCommand } from "../src/job-command.ts";

it.each([false, true])(
  "sets proxy variables before launching the executable (replace=%s)",
  (replace) => {
    const argument = "literal '$(exit 99)'";
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        jobCommand(
          process.execPath,
          [
            "-e",
            "console.log(JSON.stringify([process.env.HTTPS_PROXY,process.argv[1]]))",
            argument,
          ],
          replace,
        ),
      ],
      {
        env: { HTTPS_PROXY: "http://job:synthetic@localhost:1234" },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["http://job:synthetic@127.0.0.1:1234", argument]);
  },
);
