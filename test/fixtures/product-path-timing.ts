import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export async function prepareProductPathTiming(runtimeRoot: string, destination: string) {
  const definitions: Array<[string, Record<string, [string, string]>]> = [
    [
      "platform-node/capabilities/sandbox-host-verifier",
      {
        verifySandboxHost: ['"host.verify"', "input.plan?.identity"],
        inspectSandboxRuntime: ['"runtime.inspect." + request.mode', "null"],
      },
    ],
    [
      "platform-node/capabilities/artifact-verifier",
      { digestRegularFile: ['"artifact.digest"', "null"] },
    ],
    ["platform-node/payload-protector", { protect: ['"payload.encrypt"', "null"] }],
    [
      "persistence-sqlite/sqlite-run-payload-artifact-operations",
      { execute: ['"sqlite.artifact." + operation', "null"] },
    ],
    [
      "persistence-sqlite/sqlite-sandbox-execution-operations",
      { execute: ['"sqlite.sandbox." + operation', "raw?.plan?.identity ?? raw?.identity"] },
    ],
    [
      "agent-service/production-sandbox-services",
      { prepareRuntimeV2: ['"reservation.prepare"', "{runId: call.runId}"] },
    ],
    [
      "agent-service/production-sandbox-control",
      {
        registerPreparation: ['"control.register_preparation"', "plan.identity"],
        register: ['"control.register_ready"', "plan.identity"],
      },
    ],
    [
      "agent-service/production-sandbox-tool-result",
      { returned: ['"result.deliver"', "{runId: input.runId}"] },
    ],
    [
      "execution-worker/production-sandbox-execution-v2",
      {
        rpc: ['"worker.rpc." + command.kind', "entry.identity"],
        hostBinding: ['"worker.host_binding"', "plan.identity"],
      },
    ],
    ["runtime-sandbox/job-host", { prepareSandboxJobHost: ['"host.create"', "value"] }],
    [
      "runtime-sandbox/job-host-main",
      {
        prepare: ['"host.prepare"', "value"],
        start: ['"host.start"', "request"],
        finish: ['"host.finish"', "request"],
      },
    ],
  ];
  const manifest: Record<string, { digest: string; source: string }> = {};
  const inventory: Array<{ module: string; functions: string[] }> = [];
  for (const [module, names] of definitions) {
    const [pkg, ...rest] = module.split("/");
    const filename = path.join(
      runtimeRoot,
      "node_modules/@himawari-agent",
      pkg ?? "",
      "dist",
      `${rest.join("/")}.js`,
    );
    const source = await readFile(filename, "utf8");
    const tree = ts.createSourceFile(
      filename,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const edits: Array<{ start: number; end: number; value: string }> = [];
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      const named =
        ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
          ? node.name?.getText(tree)
          : ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent)
            ? node.parent.name.getText(tree)
            : ts.isArrowFunction(node) &&
                ts.isReturnStatement(node.parent) &&
                module === "agent-service/production-sandbox-tool-result"
              ? "returned"
              : undefined;
      const definition = named && names[named];
      if (definition && "body" in node && node.body && ts.isBlock(node.body as ts.Node)) {
        const body = node.body as ts.Block;
        const async =
          ts.canHaveModifiers(node) &&
          ts.getModifiers(node)?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword);
        edits.push({
          start: body.getStart(tree),
          end: body.end,
          value: `{ return __hmaMeasure(${definition[0]}, ${definition[1]}, ${async ? "async " : ""}() => ${body.getText(tree)}); }`,
        });
        found.push(named as string);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    const required = Object.keys(names).filter((name) => name !== "registerPreparation");
    if (required.some((name) => !found.includes(name)))
      throw new Error(
        `PRODUCT_TIMING_TARGET_MISSING:${module}:${required.filter((name) => !found.includes(name)).join(",")}`,
      );
    let modified = source;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      modified = modified.slice(0, edit.start) + edit.value + modified.slice(edit.end);
    const helper = new URL("./product-path-timing-runtime.mjs", import.meta.url).href;
    manifest[pathToFileURL(filename).href] = {
      digest: createHash("sha256").update(source).digest("hex"),
      source: `import { measure as __hmaMeasure } from ${JSON.stringify(helper)};\n${modified}`,
    };
    inventory.push({ module, functions: found });
  }
  await writeFile(destination, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(`${destination}.inventory.json`, JSON.stringify(inventory, null, 2), {
    mode: 0o600,
  });
}
