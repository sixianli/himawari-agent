import { canonical, sha256 } from "./container-records.ts";

export const INIT_SCRIPT = 'd=$1; while [ "$(date +%s)" -lt "$d" ]; do sleep 1; done';
export const INIT_NAME = "himawari-init";
export const TASK_WORKDIR = "/tmp";
export const TASK_ENVIRONMENT = [
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "XDG_CACHE_HOME=/tmp/.cache",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
];
export const RUNTIME_MOUNT_TARGET = "/opt/himawari";

export function containerRunnerDigest(runtimeDigest: string | null) {
  return sha256(
    canonical({
      init: ["/bin/sh", "-c", INIT_SCRIPT, INIT_NAME],
      task: { environment: TASK_ENVIRONMENT, workdir: TASK_WORKDIR },
      ...(runtimeDigest
        ? { runtime: { target: RUNTIME_MOUNT_TARGET, digest: runtimeDigest } }
        : {}),
    }),
  );
}
