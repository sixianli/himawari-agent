import {
  array,
  ContractValidationError,
  type InferSchema,
  integer,
  literal,
  machineString,
  object,
  type Schema,
} from "./validation.ts";

const absolutePath: Schema<string> = {
  parse(value, path = "$") {
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      !value.startsWith("/") ||
      value === "/" ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      /[*?[\]{}]/.test(value) ||
      value.endsWith("/") ||
      value.includes("//") ||
      value.split("/").some((part) => part === "." || part === "..")
    )
      throw new ContractValidationError(path, "expected a literal normalized absolute path");
    return value;
  },
};
const digest: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new ContractValidationError(path, "expected SHA-256 digest");
    return value;
  },
};
const artifactDigest: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !value.startsWith("sha256:"))
      throw new ContractValidationError(path, "expected artifact digest");
    digest.parse(value.slice(7), path);
    return value;
  },
};
export const sandboxNetworkDomainSchema: Schema<string> = {
  parse(value, path = "$") {
    if (
      typeof value !== "string" ||
      value.length > 253 ||
      value !== value.toLowerCase() ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
    )
      throw new ContractValidationError(path, "expected an exact DNS hostname");
    return value;
  },
};
const shape = object({
  schemaVersion: literal("sandbox-host-binding.v1"),
  capabilityRef: machineString,
  capabilityVersion: machineString,
  artifactDigest,
  hostId: machineString,
  profileRef: machineString,
  runtimeRoot: absolutePath,
  runtimeDigest: digest,
  executable: object({ path: absolutePath, sha256: digest }),
  runner: object({ path: absolutePath, sha256: digest }),
  privateRoot: absolutePath,
  roots: array(
    object({
      canonicalRootId: machineString,
      canonicalPath: absolutePath,
      device: machineString,
      inode: machineString,
    }),
  ),
  readOnlyToolchainPaths: array(absolutePath),
  protectedPaths: array(absolutePath),
  allowedDomains: array(sandboxNetworkDomainSchema),
  maximumResourceCeiling: object({
    maxWallTimeMs: integer(1),
    maxCpuTimeMs: integer(1),
    maxMemoryBytes: integer(1),
    maxOutputBytes: integer(1, 16777216),
    maxProgressEvents: integer(1),
  }),
});
export type SandboxHostBinding = InferSchema<typeof shape>;
function contains(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent}/`);
}
export const sandboxHostBindingSchema: Schema<SandboxHostBinding> = {
  parse(value, path = "$") {
    const binding = shape.parse(value, path);
    if (
      binding.roots.length === 0 ||
      new Set(binding.roots.map((root) => root.canonicalRootId)).size !== binding.roots.length ||
      new Set(binding.allowedDomains).size !== binding.allowedDomains.length ||
      !contains(binding.runtimeRoot, binding.runner.path) ||
      ![binding.runtimeRoot, ...binding.readOnlyToolchainPaths].some((root) =>
        contains(root, binding.executable.path),
      ) ||
      binding.roots.some((root, index) =>
        binding.roots
          .slice(index + 1)
          .some(
            (other) =>
              contains(root.canonicalPath, other.canonicalPath) ||
              contains(other.canonicalPath, root.canonicalPath),
          ),
      ) ||
      binding.roots.some((root) =>
        [binding.runtimeRoot, binding.privateRoot, ...binding.readOnlyToolchainPaths].some(
          (protectedRoot) =>
            contains(root.canonicalPath, protectedRoot) ||
            contains(protectedRoot, root.canonicalPath),
        ),
      ) ||
      contains(binding.privateRoot, binding.runtimeRoot) ||
      contains(binding.runtimeRoot, binding.privateRoot)
    )
      throw new ContractValidationError(
        path,
        "sandbox host layout is ambiguous or reopens trusted paths",
      );
    return binding;
  },
};
