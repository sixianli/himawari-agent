import process from "node:process";
import { publicSearchFailure } from "@himawari-agent/platform-node";
import { runWebSearch, webProviderFactory } from "../web-tool-run.js";
import { programProviders, programSecrets, readProgramInput } from "./web-program-io.js";

const failed = (failure: { readonly code: string | null; readonly output: string }) => {
  process.stdout.write(failure.output);
  process.stderr.write(`${failure.code}\n`);
  process.exitCode = 1;
};

try {
  const args = await readProgramInput("WEB_SEARCH");
  if (
    Object.keys(args).some((key) => !["query", "limit", "providers", "secrets"].includes(key)) ||
    typeof args["query"] !== "string" ||
    (args["limit"] !== undefined && typeof args["limit"] !== "number")
  )
    throw new Error("WEB_SEARCH_INPUT_INVALID");
  const secrets = programSecrets(args["secrets"], "WEB_SEARCH");
  const outcome = await runWebSearch({
    providers: programProviders(args["providers"], "WEB_SEARCH"),
    secrets,
    query: args["query"],
    limit: (args["limit"] as number | undefined) ?? 5,
    create: webProviderFactory(secrets),
  });
  if (outcome.ok) process.stdout.write(outcome.output);
  else failed(outcome);
} catch (error) {
  failed(publicSearchFailure(error));
}
