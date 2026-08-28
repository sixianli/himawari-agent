import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repositoryRoot, "test/fixtures/v0.2/security-invariants.json");

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(entryPath)));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

function relative(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function externalVersionIsExact(version) {
  return (
    /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) ||
    version === "0.0.0" ||
    version.startsWith("workspace:")
  );
}

function extractRoutes(source) {
  const routes = [];
  const pattern = /app\.(get|post|put|patch|delete)(?:<[\s\S]{0,240}?>)?\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    routes.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  return routes;
}

export async function checkV02Invariants() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const errors = [];
  if (manifest.schemaVersion !== 1)
    errors.push(`unsupported manifest schema ${manifest.schemaVersion}`);

  const productionFiles = [];
  for (const root of manifest.productionRoots) {
    productionFiles.push(...(await filesUnder(path.join(repositoryRoot, root))));
  }
  const sourceFiles = productionFiles.filter((filePath) => {
    const normalized = `/${relative(filePath)}`;
    return (
      filePath.endsWith(".ts") &&
      !filePath.endsWith(".test.ts") &&
      !manifest.excludedSourceSegments.some((segment) => normalized.includes(segment))
    );
  });
  const sourceEntries = await Promise.all(
    sourceFiles.map(async (filePath) => [relative(filePath), await readFile(filePath, "utf8")]),
  );

  for (const [file, source] of sourceEntries) {
    for (const literal of manifest.forbiddenCapabilityLiterals) {
      const quoted = [`"${literal}"`, `'${literal}'`, `\`${literal}\``];
      if (quoted.some((candidate) => source.includes(candidate))) {
        errors.push(`${file} exposes excluded capability literal ${literal}`);
      }
    }
    for (const fragment of manifest.forbiddenRouteFragments) {
      if (source.includes(fragment)) errors.push(`${file} exposes excluded route ${fragment}`);
    }
  }

  const httpSourcePath = path.join(
    repositoryRoot,
    "packages/platform-node/src/http-gateway-server.ts",
  );
  const discoveredRoutes = extractRoutes(await readFile(httpSourcePath, "utf8")).sort();
  const allowedRoutes = [...manifest.allowedHttpRoutes].sort();
  for (const route of discoveredRoutes) {
    if (!allowedRoutes.includes(route)) errors.push(`unreviewed HTTP route ${route}`);
  }
  for (const route of allowedRoutes) {
    if (!discoveredRoutes.includes(route)) errors.push(`reviewed HTTP route disappeared ${route}`);
  }

  const packageFiles = productionFiles.filter((filePath) => filePath.endsWith("package.json"));
  packageFiles.push(path.join(repositoryRoot, "package.json"));
  for (const packageFile of packageFiles) {
    const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [dependency, version] of Object.entries(packageJson[section] ?? {})) {
        if (manifest.forbiddenDependencies.includes(dependency)) {
          errors.push(`${relative(packageFile)} includes excluded dependency ${dependency}`);
        }
        if (!externalVersionIsExact(version)) {
          errors.push(`${relative(packageFile)} ${dependency} is not pinned exactly: ${version}`);
        }
      }
    }
  }

  for (const guard of manifest.requiredGuards) {
    const source = await readFile(path.join(repositoryRoot, guard.path), "utf8");
    for (const required of guard.all) {
      if (!source.includes(required))
        errors.push(`${guard.path} is missing required guard ${required}`);
    }
  }

  return {
    errors,
    scannedSourceFiles: sourceFiles.length,
    scannedPackageFiles: packageFiles.length,
    reviewedRoutes: discoveredRoutes.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkV02Invariants();
  if (result.errors.length > 0) {
    process.stderr.write(`${JSON.stringify({ status: "failed", ...result })}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ status: "passed", ...result })}\n`);
  }
}
