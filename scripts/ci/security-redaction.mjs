import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { safeRelativePath } from "./contracts.mjs";
import { createPublishedFixtureReview } from "./security-published-fixtures.mjs";
import { findBuildSecrets } from "./security-source.mjs";

const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?[A-Za-z0-9._~+/=-]{12,}(?:\\?["'])?/gi,
];
const maximumExpandedBytes = 256 * 1024 * 1024;

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

export function redactText(text, { sentinels = [] } = {}) {
  let output = String(text);
  for (const sentinel of sentinels) {
    assert(typeof sentinel === "string" && sentinel.length > 0, "PUBLIC_SENTINEL_INVALID");
    output = output.split(sentinel).join("[REDACTED]");
  }
  for (const pattern of patterns) output = output.replace(pattern, "[REDACTED]");
  return output;
}

function assertClean(bytes, sentinels) {
  const text = bytes.toString("utf8");
  assert(redactText(text, { sentinels }) === text, "PUBLIC_ARTIFACT_CONTAINS_SECRET");
}

function inspectZip(bytes, sentinels, depth) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= Math.max(0, bytes.length - 65_557), "PUBLIC_ZIP_DIRECTORY_MISSING");
  assert(
    bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0,
    "PUBLIC_ZIP_MULTIDISK_UNSUPPORTED",
  );
  const count = bytes.readUInt16LE(end + 10);
  assert(count > 0 && count !== 0xffff, "PUBLIC_ZIP_EMPTY_OR_ZIP64");
  let offset = bytes.readUInt32LE(end + 16);
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    assert(
      offset + 46 <= bytes.length && bytes.readUInt32LE(offset) === 0x02014b50,
      "PUBLIC_ZIP_DIRECTORY_INVALID",
    );
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert(safeRelativePath(name.replace(/\/$/, "")), "PUBLIC_ARCHIVE_PATH_INVALID");
    assert(
      (flags & 1) === 0 && [0, 8].includes(compression),
      "PUBLIC_ZIP_ENCRYPTED_OR_UNSUPPORTED",
    );
    assert(((externalAttributes >>> 16) & 0o170000) !== 0o120000, "PUBLIC_ARCHIVE_SYMLINK");
    expanded += size;
    assert(expanded <= maximumExpandedBytes, "PUBLIC_ARCHIVE_EXPANSION_LIMIT");
    assert(
      local + 30 <= bytes.length && bytes.readUInt32LE(local) === 0x04034b50,
      "PUBLIC_ZIP_LOCAL_HEADER_INVALID",
    );
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert(start + compressedSize <= bytes.length, "PUBLIC_ZIP_TRUNCATED");
    const compressed = bytes.subarray(start, start + compressedSize);
    const content =
      compression === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: maximumExpandedBytes });
    assert(content.length === size, "PUBLIC_ZIP_SIZE_MISMATCH");
    assertClean(Buffer.from(name), sentinels);
    inspectBytes(content, sentinels, depth + 1);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function inspectBytes(bytes, sentinels, depth = 0) {
  assert(depth <= 4 && bytes.length <= maximumExpandedBytes, "PUBLIC_ARCHIVE_EXPANSION_LIMIT");
  assertClean(bytes, sentinels);
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50)
    inspectZip(bytes, sentinels, depth);
  else if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    inspectBytes(
      gunzipSync(bytes, { maxOutputLength: maximumExpandedBytes }),
      sentinels,
      depth + 1,
    );
}

/** Public upload admission requires an exact list and content checks, including compressed trace bodies. */
export async function assertPublicArtifacts({
  root,
  entries,
  allowed,
  sentinels = [],
  python = process.env.HIMAWARI_CI_PYTHON,
  context,
  policyRoot = root,
  now,
  onReview,
}) {
  assert(
    Array.isArray(entries) && entries.length > 0 && Array.isArray(allowed),
    "PUBLIC_ARTIFACT_LIST_MISSING",
  );
  const kinds = ["json", "junit", "lcov", "log", "screenshot", "trace", "artifact"];
  const expected = new Map();
  for (const item of allowed) {
    assert(
      safeRelativePath(item.path) && kinds.includes(item.kind) && !expected.has(item.path),
      "PUBLIC_ALLOWLIST_INVALID",
    );
    expected.set(item.path, item.kind);
  }
  const observed = new Set();
  const actualRoot = realpathSync(root);
  for (const entry of entries) {
    assert(
      safeRelativePath(entry.path) &&
        expected.get(entry.path) === entry.kind &&
        !observed.has(entry.path),
      "PUBLIC_ARTIFACT_NOT_ALLOWLISTED",
    );
    observed.add(entry.path);
    assert(
      !/(?:^|\/)(?:\.git|node_modules|\.env(?:\.|$)|state|secrets|s9-host-evidence)(?:\/|$)/i.test(
        entry.path,
      ),
      "PUBLIC_ARTIFACT_FORBIDDEN_SOURCE",
    );
    const classifications = ["screenshot", "trace"].includes(entry.kind)
      ? ["synthetic"]
      : entry.kind === "artifact"
        ? ["synthetic", "build"]
        : ["synthetic", "redacted"];
    assert(
      classifications.includes(entry.classification),
      "PUBLIC_ARTIFACT_CLASSIFICATION_INVALID",
    );
    const file = join(root, entry.path);
    assert(
      lstatSync(file).isFile() && realpathSync(file) === join(actualRoot, entry.path),
      "PUBLIC_ARTIFACT_SYMLINK_OR_NOT_FILE",
    );
    const size = lstatSync(file).size;
    assert(size > 0, "PUBLIC_ARTIFACT_EMPTY");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert(hash.digest("hex") === entry.sha256, "PUBLIC_ARTIFACT_DIGEST_MISMATCH");
    if (entry.kind === "artifact") {
      const review =
        entry.classification === "build"
          ? createPublishedFixtureReview({ root: policyRoot, context, now })
          : null;
      await inspectBuildArchive(file, { python, sentinels, review });
      if (review) onReview?.({ path: entry.path, ...review.finish() });
    } else {
      assert(size <= maximumExpandedBytes, "PUBLIC_ARTIFACT_SIZE_LIMIT");
      inspectBytes(readFileSync(file), sentinels);
    }
  }
  return entries;
}

async function inspectBuildArchive(file, { python, sentinels, review }) {
  assert(python && isAbsolute(python), "PUBLIC_ARCHIVE_LOCKED_PYTHON_REQUIRED");
  const env = { PATH: "/usr/bin:/bin", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
  const version = spawnSync(python, ["--version"], { env, encoding: "utf8" });
  assert(
    version.status === 0 && version.stdout.trim() === "Python 3.12.10",
    "PUBLIC_ARCHIVE_PYTHON_VERSION_MISMATCH",
  );
  const helper = fileURLToPath(new URL("./artifact-archive.py", import.meta.url));
  const child = spawn(python, ["-I", "-B", helper, "stream", file], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  const closed = new Promise((settle) => {
    child.once("error", () => settle({ code: null }));
    child.once("close", (code) => settle({ code }));
  });
  let pending = Buffer.alloc(0);
  let member = null;
  let count = 0;
  let total = 0;
  const timeout = setTimeout(() => child.kill(), 300_000);
  try {
    for await (const chunk of child.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (!member) {
          const end = pending.indexOf(10);
          if (end === -1) {
            assert(pending.length < 16_384, "PUBLIC_ARCHIVE_STREAM_HEADER_INVALID");
            break;
          }
          let header;
          try {
            header = JSON.parse(pending.subarray(0, end).toString("utf8"));
          } catch {
            throw new Error("PUBLIC_ARCHIVE_STREAM_HEADER_INVALID");
          }
          assert(
            safeRelativePath(header.name) &&
              Number.isSafeInteger(header.size) &&
              header.size >= 0 &&
              header.size <= maximumExpandedBytes,
            "PUBLIC_ARCHIVE_MEMBER_INVALID",
          );
          total += header.size;
          assert(total <= 2 * 1024 * 1024 * 1024, "PUBLIC_ARCHIVE_EXPANSION_LIMIT");
          assertClean(Buffer.from(header.name), sentinels);
          member = { name: header.name, remaining: header.size, size: header.size, chunks: [] };
          pending = pending.subarray(end + 1);
        }
        const take = Math.min(member.remaining, pending.length);
        if (take) member.chunks.push(pending.subarray(0, take));
        pending = pending.subarray(take);
        member.remaining -= take;
        if (member.remaining === 0) {
          const bytes = Buffer.concat(member.chunks, member.size);
          const findings = findBuildSecrets({ name: member.name, bytes, sentinels });
          if (review) review.inspect({ name: member.name, bytes, findings });
          else assert(findings.length === 0, "PUBLIC_ARTIFACT_CONTAINS_SECRET");
          if (
            (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) ||
            (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
          )
            inspectBytes(bytes, sentinels);
          member = null;
          count++;
        } else break;
      }
    }
    const result = await closed;
    assert(
      result.code === 0 && count > 0 && member === null && pending.length === 0,
      "PUBLIC_ARCHIVE_STREAM_INCOMPLETE",
    );
  } catch (error) {
    child.kill();
    await closed;
    throw new Error(
      /^PUBLIC_[A-Z_]+$/.test(error.message) ? error.message : "PUBLIC_ARCHIVE_STREAM_INCOMPLETE",
    );
  } finally {
    clearTimeout(timeout);
  }
}
