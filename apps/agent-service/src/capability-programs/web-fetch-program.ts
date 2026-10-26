import process from "node:process";
import { publicFetchFailure, SANDBOX_PROXY } from "@himawari-agent/platform-node";
import { runWebFetch, webProviderFactory } from "../web-tool-run.js";
import { programProviders, programSecrets, readProgramInput } from "./web-program-io.js";

const failed = (failure: { readonly code: string | null; readonly output: string }) => {
  process.stdout.write(failure.output);
  process.stderr.write(`${failure.code}\n`);
  process.exitCode = 1;
};

export async function runWebFetchProgram(): Promise<void> {
  try {
    const args = await readProgramInput("WEB_FETCH");
    if (
      Object.keys(args).some(
        (key) => !["url", "offset", "maximumBytes", "providers", "secrets"].includes(key),
      ) ||
      typeof args["url"] !== "string" ||
      (args["offset"] !== undefined && typeof args["offset"] !== "number") ||
      (args["maximumBytes"] !== undefined && typeof args["maximumBytes"] !== "number")
    )
      throw new Error("WEB_FETCH_INPUT_INVALID");
    const secrets = programSecrets(args["secrets"], "WEB_FETCH");
    const outcome = await runWebFetch({
      providers: programProviders(args["providers"], "WEB_FETCH"),
      url: args["url"],
      offset: (args["offset"] as number | undefined) ?? 0,
      maximumBytes: (args["maximumBytes"] as number | undefined) ?? 32 * 1024,
      create: webProviderFactory(secrets, SANDBOX_PROXY),
    });
    if (outcome.ok) process.stdout.write(outcome.output);
    else failed(outcome);
  } catch (error) {
    failed(publicFetchFailure(error));
  }
}
