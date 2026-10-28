import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory, renderTrend } from "./history.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const historyFile = path.join(repositoryRoot, "evals/jarvis-test/history.jsonl");

console.log(renderTrend(await readHistory(historyFile)));
