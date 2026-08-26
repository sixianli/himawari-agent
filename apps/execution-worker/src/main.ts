import process from "node:process";
import { runExecutionWorkerService } from "./service-main.js";

process.exitCode = await runExecutionWorkerService(process.argv.slice(2));
