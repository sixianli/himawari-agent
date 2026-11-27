import { createECDH } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { webPushPublicKey } from "@himawari-agent/platform-node";
import { runOutagePush } from "./outage-push-command.js";

const SECRET_REF = "web-push-vapid";
const SECRET_VERSION = "v1";

export async function runPushCommand(arguments_: readonly string[]): Promise<unknown> {
  if (arguments_[1] === "outage") return runOutagePush(arguments_);
  if (
    arguments_.length !== 4 ||
    arguments_[1] !== "init-key" ||
    arguments_[2] !== "--state-root" ||
    !arguments_[3] ||
    !path.isAbsolute(arguments_[3])
  )
    throw new Error("PUSH_ARGUMENT_INVALID");
  const directory = path.join(arguments_[3], "secrets");
  const info = await lstat(directory).catch(() => undefined);
  if (!info?.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error("PUSH_SECRET_DIRECTORY_INVALID");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const privateKey = Buffer.alloc(32);
  const generated = ecdh.getPrivateKey();
  generated.copy(privateKey, 32 - generated.length);
  const secretFile = path.join(directory, `${SECRET_REF}.${SECRET_VERSION}`);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      secretFile,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("PUSH_SECRET_EXISTS");
    throw error;
  }
  try {
    await file.writeFile(privateKey.toString("base64"));
    await file.sync();
  } finally {
    await file.close();
  }
  const publicKey = webPushPublicKey(privateKey);
  privateKey.fill(0);
  return Object.freeze({
    outputSchemaVersion: 1,
    command: "push.init-key",
    secretFile,
    publicKey,
    configuration: {
      secretReference: {
        ref: SECRET_REF,
        version: SECRET_VERSION,
        purpose: "web-push",
        scope: "agent",
      },
      runPolicy: { webPush: { secretRef: SECRET_REF, subject: "mailto:<owner email>" } },
    },
  });
}
