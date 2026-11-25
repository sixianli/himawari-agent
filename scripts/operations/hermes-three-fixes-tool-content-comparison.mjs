import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "HISTORICAL_PROVIDER_PROBE_RETIRED: docs/adr/0048-vercel-ai-gateway-replaces-openrouter.md",
  );
}
