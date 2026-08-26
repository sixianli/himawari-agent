import process from "node:process";
import { runAdminCli } from "./index.js";

process.exitCode = await runAdminCli(process.argv.slice(2));
