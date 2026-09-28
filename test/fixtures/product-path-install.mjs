import { readFile } from "node:fs/promises";
import { installNodeRuntime } from "../../scripts/install-node-runtime.mjs";
const [prefix, archive, contextFile, root] = process.argv.slice(2);
const context = JSON.parse(await readFile(contextFile, "utf8"));
await installNodeRuntime({ prefix, archive, context, root });
