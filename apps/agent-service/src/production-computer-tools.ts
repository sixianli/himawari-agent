import type {
  ClockPort,
  HostDirectoryGrant,
  ProductConfiguration,
} from "@himawari-agent/application";
import {
  PI_CONTAINER_RUNNER_PATH,
  piContainerRunnerInputSchema,
} from "@himawari-agent/execution-contracts";
import { CapabilityDeploymentSnapshotLoader } from "@himawari-agent/platform-node";
import {
  COMPUTER_HOME,
  COMPUTER_RUNTIME,
  COMPUTER_WORKSPACE,
  UserComputerClient,
  UserComputerError,
  type UserComputers,
  type UserComputerWorkspaces,
} from "@himawari-agent/runtime-sandbox/computers";

export const COMPUTER_TOOLS = ["read", "write", "edit", "bash", "find", "grep", "ls"] as const;
export type ComputerToolName = (typeof COMPUTER_TOOLS)[number];

export function isComputerTool(tool: string): tool is ComputerToolName {
  return (COMPUTER_TOOLS as readonly string[]).includes(tool);
}

export interface ProductionComputerToolInput {
  readonly ownerId: string;
  readonly tool: ComputerToolName;
  readonly toolCallId: string;
  readonly hostId: string;
  readonly grant: HostDirectoryGrant;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly relativePath: string | null;
  readonly maximumOutputBytes: number;
  readonly deadlineAt: string;
}

export interface ProductionComputerToolResult {
  readonly modelContent: string;
  readonly isError: boolean;
  readonly errorCode: string | null;
}

export interface ProductionComputerTools {
  execute(input: ProductionComputerToolInput): Promise<ProductionComputerToolResult>;
}

const RESERVED_ROOTS = [COMPUTER_HOME, COMPUTER_RUNTIME, "/proc", "/sys", "/dev"];

export function computerAliasPath(displayPath: string): string | null {
  const normalized = displayPath.replace(/\/+$/, "");
  if (!normalized.startsWith("/") || normalized.split("/").length < 3) return null;
  if (normalized.split("/").some((part) => part === "." || part === "..")) return null;
  if (RESERVED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`)))
    return null;
  return normalized;
}

function computerFailure(error: unknown): ProductionComputerToolResult {
  if (error instanceof UserComputerError)
    return {
      modelContent: `工具没有在你的电脑里执行：${error.code}${error.detail ? `（${error.detail}）` : ""}`,
      isError: true,
      errorCode: error.code,
    };
  return {
    modelContent: "工具没有在你的电脑里执行：COMPUTER_UNAVAILABLE",
    isError: true,
    errorCode: "COMPUTER_UNAVAILABLE",
  };
}

export function createProductionComputerTools(options: {
  readonly computers: UserComputers & UserComputerWorkspaces;
  readonly runtimeRoot: () => string;
  readonly networkDomains: (tool: ComputerToolName) => readonly string[];
}): ProductionComputerTools {
  const seeded = new Map<string, Promise<void>>();
  const seed = (ownerId: string, grant: HostDirectoryGrant) => {
    const key = `${ownerId}\0${grant.id}`;
    let pending = seeded.get(key);
    if (!pending) {
      pending = options.computers
        .seedWorkspace({ ownerId, source: grant.displayPath })
        .then(() => undefined);
      pending.catch(() => seeded.delete(key));
      seeded.set(key, pending);
    }
    return pending;
  };
  return {
    async execute(input) {
      try {
        await seed(input.ownerId, input.grant);
      } catch (error) {
        return computerFailure(error);
      }
      const parameters =
        input.relativePath === null
          ? input.parameters
          : { ...input.parameters, path: input.relativePath === "" ? "." : input.relativePath };
      const runnerInput = piContainerRunnerInputSchema.parse({
        schemaVersion: "pi-container-runner.v1",
        tool: input.tool,
        toolCallId: input.toolCallId,
        hostId: input.hostId,
        canonicalRootId: input.grant.canonicalRootId,
        workspace: COMPUTER_WORKSPACE,
        grantRef: input.grant.id,
        grantRevision: input.grant.revision,
        authorizationRef: input.grant.authorizationRef,
        access: input.grant.operations.some((operation) => operation !== "read") ? "write" : "read",
        expiresAt: input.deadlineAt,
        maxOutputBytes: input.maximumOutputBytes,
        parametersJson: JSON.stringify(parameters),
      });
      const alias = computerAliasPath(input.grant.displayPath);
      const argv = alias
        ? [
            "sh",
            "-c",
            'mkdir -p "$(dirname "$1")" 2>/dev/null && ln -sfn "$2" "$1" 2>/dev/null; shift 2; exec node "$@"',
            "himawari-tool",
            alias,
            COMPUTER_WORKSPACE,
            PI_CONTAINER_RUNNER_PATH,
            JSON.stringify(runnerInput),
          ]
        : ["node", PI_CONTAINER_RUNNER_PATH, JSON.stringify(runnerInput)];
      let executed: Awaited<ReturnType<UserComputers["exec"]>>;
      try {
        executed = await options.computers.exec({
          ownerId: input.ownerId,
          argv,
          cwd: COMPUTER_WORKSPACE,
          allowedDomains: options.networkDomains(input.tool),
          deadlineAt: input.deadlineAt,
          maxOutputBytes: input.maximumOutputBytes,
          runtime: options.runtimeRoot(),
        });
      } catch (error) {
        return computerFailure(error);
      }
      const output = new TextDecoder().decode(executed.stdout);
      if (executed.truncated)
        return {
          modelContent: "PI_RESULT_OUTPUT_LIMIT",
          isError: true,
          errorCode: "PI_RESULT_OUTPUT_LIMIT",
        };
      let parsed: { readonly isError?: unknown } | null = null;
      try {
        parsed = JSON.parse(output) as { readonly isError?: unknown };
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed.isError !== "boolean")
        return {
          modelContent: "工具在你的电脑里没有返回结果：PI_RUNNER_EXECUTION_FAILED",
          isError: true,
          errorCode: "PI_RUNNER_EXECUTION_FAILED",
        };
      return {
        modelContent: output,
        isError: parsed.isError,
        errorCode: parsed.isError ? "COMPUTER_TOOL_FAILED" : null,
      };
    },
  };
}

export async function createConfiguredComputerTools(
  configuration: Pick<ProductConfiguration, "capabilityDeployment" | "runPolicy">,
  clock: ClockPort,
): Promise<ProductionComputerTools | undefined> {
  const computers = configuration.runPolicy?.userComputers;
  const coding = configuration.runPolicy?.coding;
  if (!computers || !coding) return undefined;
  if (!configuration.capabilityDeployment) throw new Error("COMPUTER_RUNTIME_UNAVAILABLE");
  const loaded = await new CapabilityDeploymentSnapshotLoader({
    ...configuration.capabilityDeployment,
    now: () => clock.now(),
  }).load();
  const entry = loaded.snapshot.capabilities.find(
    (candidate) =>
      candidate.binding.kind === "sandbox" &&
      candidate.manifest.ref === coding.capabilityRef &&
      candidate.manifest.version === coding.capabilityVersion,
  );
  if (!entry || entry.binding.kind !== "sandbox") throw new Error("COMPUTER_RUNTIME_UNAVAILABLE");
  const binding = entry.binding.value;
  const network = new Map(
    (binding.operationBindings ?? []).map((item) => [item.operation, item.network]),
  );
  return createProductionComputerTools({
    computers: new UserComputerClient(computers.socketPath),
    runtimeRoot: () => binding.runtimeRoot,
    networkDomains: (tool) =>
      network.get(tool) === "grant_targets" ? [...binding.allowedDomains] : [],
  });
}
