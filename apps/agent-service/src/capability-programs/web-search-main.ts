import process from "node:process";
import {
  publicSearchFailure,
  searchWithProviders,
  WebProviderChainError,
} from "@himawari-agent/platform-node";
import {
  programProvider,
  programProviders,
  programSecrets,
  providerSource,
  readProgramInput,
} from "./web-program-io.js";

try {
  const args = await readProgramInput("WEB_SEARCH");
  if (
    Object.keys(args).some((key) => !["query", "limit", "providers", "secrets"].includes(key)) ||
    typeof args["query"] !== "string" ||
    (args["limit"] !== undefined && typeof args["limit"] !== "number")
  )
    throw new Error("WEB_SEARCH_INPUT_INVALID");
  const secrets = programSecrets(args["secrets"], "WEB_SEARCH");
  const searched = await searchWithProviders({
    providers: programProviders(args["providers"], "WEB_SEARCH"),
    secrets,
    query: args["query"],
    limit: (args["limit"] as number | undefined) ?? 5,
    create: programProvider(secrets),
  });
  process.stdout.write(
    JSON.stringify({
      retrievedAt: new Date().toISOString(),
      source: providerSource[searched.provider],
      provider: searched.provider,
      ...(searched.attempts.length ? { fallbackFrom: searched.attempts } : {}),
      contentKind: "search_excerpts",
      pagesOpened: false,
      results: searched.result,
    }),
  );
} catch (error) {
  const failure = publicSearchFailure(
    error instanceof WebProviderChainError ? new Error(error.last.code) : error,
  );
  process.stdout.write(failure.output);
  process.stderr.write(`${failure.code}\n`);
  process.exitCode = 1;
}
