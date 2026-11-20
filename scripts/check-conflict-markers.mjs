import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED_PREFIXES = [".agents/reviews/"];

export function findConflictMarkers(text) {
  const found = [];
  const lines = text.split("\n");
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("<<<<<<< ")) open = index + 1;
    else if (lines[index].startsWith(">>>>>>> ") && open !== null) {
      found.push({ start: open, end: index + 1 });
      open = null;
    }
  }
  return found;
}

export function trackedTextFiles() {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter((path) => path !== "" && !SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

export function scan(paths, read = (path) => readFileSync(join(root, path))) {
  const failures = [];
  for (const path of paths) {
    let content;
    try {
      content = read(path);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR") continue;
      throw error;
    }
    if (content.includes(0)) continue;
    for (const marker of findConflictMarkers(content.toString("utf8"))) {
      failures.push({ path, ...marker });
    }
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = scan(trackedTextFiles());
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`CONFLICT_MARKERS_LEFT ${failure.path}:${failure.start}-${failure.end}`);
    }
    console.error(
      "合并时没解决完的冲突标记被提交了：打开这些文件，保留应该留下的内容，删掉 <<<<<<<、=======、>>>>>>> 三种标记行",
    );
    process.exit(1);
  }
  console.log("CONFLICT_MARKERS_NONE");
}
