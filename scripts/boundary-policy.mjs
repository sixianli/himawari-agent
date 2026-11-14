export const allowedInternalDependencies = new Map([
  ["@himawari-agent/runtime-sandbox", new Set(["@himawari-agent/execution-contracts"])],
  ["@himawari-agent/domain", new Set()],
  ["@himawari-agent/calibration", new Set()],
  ["@himawari-agent/prompt-catalog", new Set()],
  ["@himawari-agent/sensitive-capture", new Set()],
  ["@himawari-agent/gateway-contracts", new Set()],
  ["@himawari-agent/execution-contracts", new Set()],
  [
    "@himawari-agent/application",
    new Set([
      "@himawari-agent/sensitive-capture",
      "@himawari-agent/calibration",
      "@himawari-agent/prompt-catalog",
      "@himawari-agent/domain",
      "@himawari-agent/gateway-contracts",
      "@himawari-agent/execution-contracts",
    ]),
  ],
  [
    "@himawari-agent/runtime-pi",
    new Set([
      "@himawari-agent/sensitive-capture",
      "@himawari-agent/prompt-catalog",
      "@himawari-agent/application",
    ]),
  ],
  [
    "@himawari-agent/persistence-sqlite",
    new Set([
      "@himawari-agent/application",
      "@himawari-agent/calibration",
      "@himawari-agent/domain",
      "@himawari-agent/gateway-contracts",
      "@himawari-agent/execution-contracts",
    ]),
  ],
  [
    "@himawari-agent/memory-engine",
    new Set([
      "@himawari-agent/sensitive-capture",
      "@himawari-agent/prompt-catalog",
      "@himawari-agent/application",
      "@himawari-agent/domain",
    ]),
  ],
  [
    "@himawari-agent/integration-github",
    new Set([
      "@himawari-agent/application",
      "@himawari-agent/domain",
      "@himawari-agent/gateway-contracts",
      "@himawari-agent/execution-contracts",
    ]),
  ],
  [
    "@himawari-agent/integration-web",
    new Set([
      "@himawari-agent/sensitive-capture",
      "@himawari-agent/application",
      "@himawari-agent/domain",
      "@himawari-agent/gateway-contracts",
      "@himawari-agent/execution-contracts",
      "@himawari-agent/testing",
    ]),
  ],
  [
    "@himawari-agent/platform-node",
    new Set([
      "@himawari-agent/sensitive-capture",
      "@himawari-agent/prompt-catalog",
      "@himawari-agent/application",
      "@himawari-agent/domain",
      "@himawari-agent/gateway-contracts",
      "@himawari-agent/execution-contracts",
    ]),
  ],
  [
    "@himawari-agent/testing",
    new Set([
      "@himawari-agent/application",
      "@himawari-agent/domain",
      "@himawari-agent/gateway-contracts",
      "@himawari-agent/execution-contracts",
    ]),
  ],
  [
    "@himawari-agent/agent-service",
    new Set([
      "@himawari-agent/sensitive-capture",
      "@himawari-agent/runtime-sandbox",
      "@himawari-agent/application",
      "@himawari-agent/calibration",
      "@himawari-agent/prompt-catalog",
      "@himawari-agent/gateway-contracts",
      "@himawari-agent/execution-contracts",
      "@himawari-agent/runtime-pi",
      "@himawari-agent/platform-node",
      "@himawari-agent/persistence-sqlite",
      "@himawari-agent/memory-engine",
      "@himawari-agent/integration-github",
      "@himawari-agent/integration-web",
      "@himawari-agent/testing",
    ]),
  ],
  [
    "@himawari-agent/execution-worker",
    new Set([
      "@himawari-agent/runtime-sandbox",
      "@himawari-agent/application",
      "@himawari-agent/execution-contracts",
      "@himawari-agent/platform-node",
      "@himawari-agent/integration-web",
      "@himawari-agent/testing",
    ]),
  ],
  [
    "@himawari-agent/control-center",
    new Set(["@himawari-agent/gateway-contracts", "@himawari-agent/sensitive-capture"]),
  ],
  [
    "@himawari-agent/admin-cli",
    new Set([
      "@himawari-agent/application",
      "@himawari-agent/persistence-sqlite",
      "@himawari-agent/platform-node",
    ]),
  ],
]);

export const nodeImportAllowedPackages = new Set([
  "@himawari-agent/runtime-sandbox",
  "@himawari-agent/runtime-pi",
  "@himawari-agent/persistence-sqlite",
  "@himawari-agent/integration-github",
  "@himawari-agent/integration-web",
  "@himawari-agent/platform-node",
  "@himawari-agent/testing",
  "@himawari-agent/agent-service",
  "@himawari-agent/execution-worker",
  "@himawari-agent/admin-cli",
]);

export const browserOnlyPackages = new Set(["@himawari-agent/control-center"]);
export const browserExternalPackages = new Set([
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "react-intl",
  "marked",
  "pdfjs-dist",
  "qrcode-generator",
  "docx-preview",
  "exceljs",
  "fflate",
  "tldts",
  "vite",
  "vitest",
]);

export const piDependencyOwner = "@himawari-agent/runtime-pi";

export function packageSpecifier(specifier) {
  if (!specifier.startsWith("@")) return specifier.split("/", 1)[0];
  return specifier.split("/", 2).join("/");
}

export function isExactExternalVersion(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

export function isInternalDependencyAllowed(packageName, dependency) {
  return allowedInternalDependencies.get(packageName)?.has(dependency) ?? false;
}

export function isNodeImportAllowed(packageName) {
  return nodeImportAllowedPackages.has(packageName);
}

export function isBrowserImportAllowed(packageName, specifier, workspaceNames) {
  if (!browserOnlyPackages.has(packageName) || specifier.startsWith(".")) return true;
  if (specifier.startsWith("node:")) return false;

  const dependency = packageSpecifier(specifier);
  if (workspaceNames.has(dependency)) {
    return isInternalDependencyAllowed(packageName, dependency);
  }
  return browserExternalPackages.has(dependency);
}

export const srtDependencyOwner = "@himawari-agent/runtime-sandbox";

const agentSandboxSubpaths = new Set([
  "@himawari-agent/runtime-sandbox/control",
  "@himawari-agent/runtime-sandbox/job-host-limits",
  "@himawari-agent/runtime-sandbox/public-address",
]);

export function isSandboxImportAllowed(packageName, specifier) {
  return (
    packageName !== "@himawari-agent/agent-service" ||
    packageSpecifier(specifier) !== "@himawari-agent/runtime-sandbox" ||
    agentSandboxSubpaths.has(specifier)
  );
}
