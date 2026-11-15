import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REF_PREFIX = "refs/review-artifacts/";
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(png|mp4)$/;
const BATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function git(cwd, args, { env, input, binary } = {}) {
  try {
    return runGit(cwd, args, { env, input, binary });
  } catch (error) {
    const detail = String(error.stderr ?? "")
      .trim()
      .split("\n")
      .slice(-2)
      .join(" | ");
    throw new Error(`UI_REVIEW_ARTIFACT_GIT_FAILED git ${args[0]}: ${detail || error.message}`);
  }
}

function runGit(cwd, args, { env, input, binary }) {
  return execFileSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding: binary ? null : "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

export function artifactRef(pr, batch) {
  if (!/^[1-9][0-9]{0,6}$/.test(String(pr))) throw new Error(`UI_REVIEW_ARTIFACT_PR_INVALID ${pr}`);
  if (!BATCH_NAME.test(String(batch))) throw new Error(`UI_REVIEW_ARTIFACT_BATCH_INVALID ${batch}`);
  return `${REF_PREFIX}pr-${pr}/${batch}`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function publish({ cwd, remote, pr, batch, dir }) {
  const ref = artifactRef(pr, batch);
  const names = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
  const rejected = names.filter((name) => !FILE_NAME.test(name));
  if (rejected.length > 0)
    throw new Error(`UI_REVIEW_ARTIFACT_FILE_REJECTED ${rejected.join(",")}`);
  if (names.length === 0) throw new Error(`UI_REVIEW_ARTIFACT_EMPTY ${dir}`);
  const scratch = mkdtempSync(join(tmpdir(), "ui-review-artifact-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    const files = [];
    for (const name of names) {
      const content = readFileSync(join(dir, name));
      const blob = git(cwd, ["hash-object", "-w", "--stdin"], { input: content }).trim();
      git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${name}`], { env });
      files.push({ path: name, bytes: content.length, sha256: sha256(content) });
    }
    const manifest = `${JSON.stringify({ schemaVersion: 1, pr: Number(pr), batch, files }, null, 2)}\n`;
    const manifestBlob = git(cwd, ["hash-object", "-w", "--stdin"], { input: manifest }).trim();
    git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${manifestBlob},manifest.json`], {
      env,
    });
    const tree = git(cwd, ["write-tree"], { env }).trim();
    const commit = git(cwd, [
      "commit-tree",
      tree,
      "-m",
      `ui-review artifacts pr-${pr} ${batch}`,
    ]).trim();
    git(cwd, ["push", "--no-verify", remote, `${commit}:${ref}`]);
    return {
      ref,
      commit,
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function fetchArtifacts({ cwd, remote, pr, batch, out }) {
  const ref = artifactRef(pr, batch);
  git(cwd, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    remote,
    `+${ref}:refs/ui-review-fetch/current`,
  ]);
  const local = "refs/ui-review-fetch/current";
  try {
    let manifest;
    try {
      manifest = JSON.parse(git(cwd, ["show", `${local}:manifest.json`]));
    } catch {
      throw new Error("UI_REVIEW_MANIFEST_MISMATCH manifest.json missing or not JSON");
    }
    if (
      manifest?.schemaVersion !== 1 ||
      manifest.pr !== Number(pr) ||
      manifest.batch !== batch ||
      !Array.isArray(manifest.files)
    )
      throw new Error("UI_REVIEW_MANIFEST_MISMATCH header");
    const listed = git(cwd, ["ls-tree", "-z", "--name-only", local])
      .split("\0")
      .filter(Boolean)
      .sort();
    const expected = [...manifest.files.map((file) => file.path), "manifest.json"].sort();
    if (JSON.stringify(listed) !== JSON.stringify(expected))
      throw new Error(
        `UI_REVIEW_MANIFEST_MISMATCH files tree=${listed.join(",")} manifest=${expected.join(",")}`,
      );
    mkdirSync(out, { recursive: true });
    if (readdirSync(out).length > 0) throw new Error(`UI_REVIEW_ARTIFACT_OUT_NOT_EMPTY ${out}`);
    for (const file of manifest.files) {
      if (!FILE_NAME.test(file.path))
        throw new Error(`UI_REVIEW_ARTIFACT_FILE_REJECTED ${file.path}`);
      const content = git(cwd, ["show", `${local}:${file.path}`], { binary: true });
      if (content.length !== file.bytes || sha256(content) !== file.sha256)
        throw new Error(`UI_REVIEW_MANIFEST_MISMATCH ${file.path}`);
      writeFileSync(join(out, file.path), content);
    }
    return { ref, files: manifest.files.length, out };
  } finally {
    git(cwd, ["update-ref", "-d", local]);
  }
}

export function deleteArtifacts({ cwd, remote, pr, batch }) {
  const ref = artifactRef(pr, batch);
  git(cwd, ["push", "--no-verify", remote, `:${ref}`]);
  return { ref };
}

export function listArtifacts({ cwd, remote, pr }) {
  if (pr !== undefined) artifactRef(pr, "probe");
  const pattern = pr === undefined ? `${REF_PREFIX}*` : `${REF_PREFIX}pr-${pr}/*`;
  return git(cwd, ["ls-remote", remote, pattern])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]);
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { remote: "origin" };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`UI_REVIEW_ARTIFACT_USAGE ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return { command, options };
}

const USAGE =
  "usage: node scripts/ui-review-artifacts.mjs publish --pr N --batch NAME --dir DIR | fetch --pr N --batch NAME --out DIR | delete --pr N --batch NAME | list [--pr N]  [--remote origin]";

function main() {
  const cwd = process.cwd();
  try {
    const { command, options } = parse(process.argv.slice(2));
    const common = { cwd, remote: options.remote, pr: options.pr, batch: options.batch };
    let result;
    if (command === "publish") result = publish({ ...common, dir: resolve(options.dir) });
    else if (command === "fetch") result = fetchArtifacts({ ...common, out: resolve(options.out) });
    else if (command === "delete") result = deleteArtifacts(common);
    else if (command === "list") {
      for (const ref of listArtifacts(common)) process.stdout.write(`${ref}\n`);
      return 0;
    } else throw new Error(USAGE);
    process.stdout.write(
      `UI_REVIEW_ARTIFACT_${command.toUpperCase()}_DONE ${JSON.stringify(result)}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message.split("\n")[0]}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
