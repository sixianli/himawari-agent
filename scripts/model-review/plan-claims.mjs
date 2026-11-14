import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const CLAIM_VERDICTS = ["一致", "不一致", "找不到"];
export const CLAIM_PROBLEM_VERDICTS = ["不一致", "找不到"];
export const CLAIM_OUTCOMES = ["plan-fixed", "model-wrong"];
export const CLAIMS_FILE_PATTERN = /^[\p{L}\p{N}._][\p{L}\p{N}._/-]*\.md$/u;
export const ADR_PATH_PATTERN = /^docs\/adr\/\d{4}-[^/]+\.md$/;
export const safe = (text) => String(text).replace(/[\p{Cc}\u2028\u2029]/gu, "?");
export const CLAIM_ID_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
export const CLAIMS_VERDICTS_FILE = "claims-verdicts.jsonl";
export const EVIDENCE_MIN_CHARS = 8;
export const CLAIMS_LINE_FORMAT =
  "CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>";
export const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function validClaimsFile(path) {
  return (
    typeof path === "string" &&
    CLAIMS_FILE_PATTERN.test(path) &&
    !path.split("/").some((part) => part === ".." || part === "" || part === ".") &&
    !path.startsWith(".agents/reviews/")
  );
}

const git = (repo, args, encoding = "utf8") =>
  spawnSync("git", args, { cwd: repo, encoding, maxBuffer: 1 << 28 });

export function blobAt(repo, commit, path) {
  const shown = git(repo, ["show", `${commit}:${path}`], null);
  return shown.status === 0 ? shown.stdout : null;
}

export function blobSha256(repo, commit, path) {
  const blob = blobAt(repo, commit, path);
  return blob === null ? null : createHash("sha256").update(blob).digest("hex");
}

const collapse = (text) => text.replace(/\s+/g, " ").trim();

export function parseClaims(text) {
  const claims = [];
  const problems = [];
  const seen = new Set();
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/^\s*(?:[-*>]\s+)?/, "");
    const number = index + 1;
    if (!line.startsWith("CLAIM|")) {
      if (/^(?:[\p{N}\p{L}]{1,3}[.．)）、:：]\s*)?[`*"'“#]*CLAIM(?![A-Za-z])/u.test(line))
        problems.push(`line-${number}-malformed`);
      continue;
    }
    const parts = line.split("|");
    const [, id = "", verdict = "", location = "", sentence = ""] = parts.map((part) =>
      part.trim(),
    );
    const code = parts.slice(5).join("|").trim();
    if (parts.length < 6 || !CLAIM_ID_PATTERN.test(id) || !CLAIM_VERDICTS.includes(verdict)) {
      problems.push(`line-${number}-malformed`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`line-${number}-duplicate-id ${id}`);
      continue;
    }
    seen.add(id);
    claims.push({ id, verdict, location, sentence, code, line: number });
  }
  return { claims, problems };
}

export function parseClaimVerdicts(text, path) {
  const seen = new Set();
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim())
    .map(({ line, number }) => {
      let verdict;
      try {
        verdict = JSON.parse(line);
      } catch {
        verdict = null;
      }
      const filled = (field) =>
        typeof verdict?.[field] === "string" &&
        verdict[field].trim() !== "" &&
        !/[\r\n]/.test(verdict[field]);
      const valid =
        verdict !== null &&
        typeof verdict === "object" &&
        ["id", "model", "quote"].every(filled) &&
        CLAIM_OUTCOMES.includes(verdict.outcome) &&
        (verdict.outcome === "plan-fixed"
          ? filled("change")
          : filled("evidenceFile") && filled("evidence"));
      const key = valid ? `${verdict.model}\0${verdict.id}` : "";
      if (!valid || seen.has(key)) throw new Error(`CLAIM_VERDICTS_INVALID ${path}:${number}`);
      seen.add(key);
      return verdict;
    });
}

function locationOf(location) {
  const match = /^`?([^\s:`]+):(\d+)(?:@([0-9a-f]+))?/.exec(location.trim());
  if (!match) return null;
  const path = match[1];
  if (!validEvidencePath(path)) return null;
  const commit = match[3] ?? null;
  if (commit !== null && !COMMIT_PATTERN.test(commit)) return null;
  return { path, line: Number(match[2]), commit };
}

function validEvidencePath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.startsWith("/") &&
    !path.startsWith("-") &&
    !path.startsWith(".agents/reviews/") &&
    !path.split("/").some((part) => part === ".." || part === "")
  );
}

function stripQuoteMarks(text) {
  return text.replace(/^[\s`'"“”‘’]+|[\s`'"“”‘’]+$/g, "");
}

function quoteFragments(quote, separator) {
  return stripQuoteMarks(quote)
    .split(separator)
    .map((fragment) => collapse(stripQuoteMarks(fragment)))
    .filter((fragment) => fragment !== "");
}

function fragmentsInOrder(fragments, haystack) {
  let from = 0;
  for (const fragment of fragments) {
    const at = fragment.length >= 4 ? haystack.indexOf(fragment, from) : -1;
    if (at === -1) return false;
    from = at + fragment.length;
  }
  return fragments.length > 0;
}

export function quoteInText(quote, text) {
  const haystack = collapse(text);
  const elided = quoteFragments(quote, /…|\.\.\./);
  if (
    elided.length > 0 &&
    elided.every((fragment) => fragment.length >= 4 && haystack.includes(fragment))
  )
    return true;
  if (elided.length > 1) {
    const pieces = quoteFragments(quote, /…|\.\.\.|；/);
    return (
      pieces.length > 0 &&
      pieces.every((fragment) => fragment.length >= 4 && haystack.includes(fragment))
    );
  }
  return fragmentsInOrder(quoteFragments(quote, /；/), haystack);
}

function isAncestor(repo, ancestor, descendant) {
  return git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

function mergeBase(repo, mainRef, tip) {
  const base = git(repo, ["merge-base", mainRef, tip]);
  return base.status === 0 ? base.stdout.trim() : null;
}

export function commitInPullRequest(repo, commit, head, mainRef, runHead = head) {
  if (!COMMIT_PATTERN.test(commit)) return false;
  const baseCommit = mergeBase(repo, mainRef, head);
  if (baseCommit === null || !isAncestor(repo, commit, head)) return false;
  if (commit === baseCommit) return true;
  if (
    runHead !== head &&
    COMMIT_PATTERN.test(runHead ?? "") &&
    isAncestor(repo, runHead, head) &&
    commit === mergeBase(repo, mainRef, runHead)
  )
    return true;
  return !isAncestor(repo, commit, baseCommit);
}

function claimEvidenceProblem(repo, head, claim, mainRef, runHead) {
  if (claim.verdict === "找不到" && !locationOf(claim.location)) return null;
  const place = locationOf(claim.location);
  if (!place) return "location-missing";
  const atHead = blobAt(repo, head, place.path);
  let blob = atHead;
  if (place.commit !== null) {
    if (!commitInPullRequest(repo, place.commit, head, mainRef, runHead)) return "commit-not-in-pr";
    blob = blobAt(repo, place.commit, place.path);
  }
  if (blob === null) return "location-file-missing";
  const text = blob.toString("utf8");
  if (place.line < 1 || place.line > text.split("\n").length) return "location-line-out-of-range";
  if (claim.verdict !== "找不到" && !quoteInText(claim.code, text)) return "code-quote-not-in-file";
  if (
    place.commit !== null &&
    claim.verdict !== "找不到" &&
    atHead !== null &&
    quoteInText(claim.code, atHead.toString("utf8"))
  )
    return "commit-quote-still-in-head";
  return null;
}

export function addedAdrs(repo, head, mainRef) {
  const base = git(repo, ["merge-base", mainRef, head]);
  if (base.status !== 0) return [];
  const diff = git(repo, [
    "diff",
    "-z",
    "--no-renames",
    "--name-only",
    "--diff-filter=A",
    base.stdout.trim(),
    head,
    "--",
    "docs/adr",
  ]);
  if (diff.status !== 0) throw new Error(`GIT_FAILED git diff: ${diff.stderr.trim()}`);
  return diff.stdout
    .split("\0")
    .filter((file) => ADR_PATH_PATTERN.test(file))
    .sort();
}

function topicLedgers(repo, head, reviewsDir) {
  const listed = git(repo, ["ls-tree", "-r", "-z", "--name-only", head, "--", reviewsDir]);
  if (listed.status !== 0) return [];
  const pattern = new RegExp(
    `^${reviewsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(topic-[a-z][a-z0-9-]*)/usage\\.jsonl$`,
  );
  return listed.stdout
    .split("\0")
    .map((file) => ({ file, match: pattern.exec(file) }))
    .filter(({ match }) => match)
    .map(({ file, match }) => ({ file, dir: `${reviewsDir}/${match[1]}` }));
}

export function carriedVerdicts(repo, head, ownRecords) {
  const seen = new Set();
  const carried = [];
  for (const record of ownRecords) {
    if (record.outcome !== "ok") continue;
    const roundDir = `${record.dir}/round-${record.round ?? 1}`;
    const key = `${roundDir}\0${record.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const answer = blobAt(repo, head, `${roundDir}/${safe(record.model.split("/").pop())}.md`);
    const verdictsText = blobAt(repo, head, `${roundDir}/${CLAIMS_VERDICTS_FILE}`);
    if (answer === null || verdictsText === null) continue;
    let verdicts;
    try {
      verdicts = parseClaimVerdicts(
        verdictsText.toString("utf8"),
        `${roundDir}/${CLAIMS_VERDICTS_FILE}`,
      );
    } catch {
      continue;
    }
    const answerText = answer.toString("utf8");
    const { claims } = parseClaims(answerText);
    for (const verdict of verdicts) {
      if (verdict.outcome !== "model-wrong" || verdict.model !== record.model) continue;
      const claim = claims.find((item) => item.id === verdict.id);
      if (!claim || !CLAIM_PROBLEM_VERDICTS.includes(claim.verdict)) continue;
      carried.push({
        model: record.model,
        sentence: collapse(claim.sentence),
        verdict,
        answerText,
      });
    }
  }
  return carried;
}

export function claimsProblems({ repo, head, mainRef, reviewsDir, parseUsage, looksSecret }) {
  const adrs = addedAdrs(repo, head, mainRef);
  const problems = [];
  const files = [];
  if (adrs.length === 0) return { problems, files };
  const records = [];
  for (const ledger of topicLedgers(repo, head, reviewsDir)) {
    const text = blobAt(repo, head, ledger.file);
    if (text === null) continue;
    let parsed;
    try {
      parsed = parseUsage(text.toString("utf8"), `HEAD:${ledger.file}`);
    } catch {
      problems.push(`claims-ledger-invalid ${safe(ledger.file)}`);
      continue;
    }
    parsed.forEach((record, order) => {
      if (record.mode === "plan-claims") records.push({ ...record, dir: ledger.dir, order });
    });
  }
  for (const adr of adrs) {
    const label = safe(adr);
    if (!validClaimsFile(adr) || looksSecret?.(adr)) {
      problems.push(`claims-name-unsupported ${label}`);
      continue;
    }
    const sha = blobSha256(repo, head, adr);
    const own = records.filter((record) => record.claimsFile === adr);
    for (const place of new Set(own.map((record) => `${record.dir}\0${record.round ?? 1}`))) {
      const [dir, roundNumber] = place.split("\0");
      const listed = git(repo, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        head,
        "--",
        `${dir}/round-${roundNumber}`,
      ]);
      files.push(`${dir}/usage.jsonl`, ...listed.stdout.split("\0").filter(Boolean));
    }
    const carried = carriedVerdicts(repo, head, own);
    const matching = own.filter((record) => record.claimsSha256 === sha);
    if (matching.length === 0) {
      problems.push(own.length > 0 ? `claims-stale ${label}` : `claims-unchecked ${label}`);
      continue;
    }
    const groups = new Map();
    for (const record of matching) {
      const key = `${record.dir}\0${record.round ?? 1}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    let anyDone = false;
    for (const group of groups.values()) {
      const latest = group[0];
      const lastByModel = new Map();
      for (const record of group) lastByModel.set(record.model, record);
      const done = [...lastByModel.values()].filter((record) => record.outcome === "ok");
      if (done.length === 0) continue;
      anyDone = true;
      for (const record of done) {
        const roundDir = `${latest.dir}/round-${record.round ?? 1}`;
        const short = safe(record.model.split("/").pop());
        const answerPath = `${roundDir}/${short}.md`;
        const answer = blobAt(repo, head, answerPath);
        if (answer === null) {
          problems.push(`claims-answer-missing ${label} ${short}`);
          continue;
        }
        const { claims, problems: parseProblems } = parseClaims(answer.toString("utf8"));
        for (const detail of parseProblems)
          problems.push(`claims-answer-invalid ${label} ${short} ${detail}`);
        if (claims.length === 0) {
          problems.push(`claims-none ${label} ${short}`);
          continue;
        }
        for (const claim of claims) {
          const why = claimEvidenceProblem(repo, head, claim, mainRef, record.head);
          if (why) problems.push(`claims-evidence ${label} ${short} ${claim.id} ${why}`);
        }
        const verdictsPath = `${roundDir}/${CLAIMS_VERDICTS_FILE}`;
        const verdictsText = blobAt(repo, head, verdictsPath);
        let verdicts = [];
        if (verdictsText !== null) {
          try {
            verdicts = parseClaimVerdicts(verdictsText.toString("utf8"), verdictsPath);
          } catch (error) {
            problems.push(`claims-verdicts-invalid ${safe(error.message)}`);
            continue;
          }
        }
        const answerText = answer.toString("utf8");
        for (const claim of claims.filter((item) =>
          CLAIM_PROBLEM_VERDICTS.includes(item.verdict),
        )) {
          const direct = verdicts.find(
            (item) => item.model === record.model && item.id === claim.id,
          );
          const earlier =
            direct?.outcome === "model-wrong"
              ? null
              : carried.find(
                  (item) =>
                    item.model === record.model && item.sentence === collapse(claim.sentence),
                );
          const verdict = direct?.outcome === "model-wrong" ? direct : earlier?.verdict;
          const verdictAnswer =
            direct?.outcome === "model-wrong" ? answerText : earlier?.answerText;
          if (!verdict || verdict.outcome !== "model-wrong") {
            problems.push(`claims-unjudged ${label} ${short} ${claim.id} ${claim.verdict}`);
            continue;
          }
          const evidenceBlob = validEvidencePath(verdict.evidenceFile)
            ? blobAt(repo, head, verdict.evidenceFile)
            : null;
          if (
            evidenceBlob === null ||
            collapse(verdict.evidence).length < EVIDENCE_MIN_CHARS ||
            !collapse(evidenceBlob.toString("utf8")).includes(collapse(verdict.evidence))
          )
            problems.push(`claims-verdict-evidence ${label} ${short} ${claim.id}`);
          if (!collapse(verdictAnswer).includes(collapse(verdict.quote)))
            problems.push(`claims-verdict-quote ${label} ${short} ${claim.id}`);
        }
      }
    }
    if (!anyDone) problems.push(`claims-run-failed ${label}`);
  }
  return { problems, files };
}
