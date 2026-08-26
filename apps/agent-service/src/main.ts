import process from "node:process";
import { runAgentService } from "./service-main.js";

process.exitCode = await runAgentService(process.argv.slice(2));
