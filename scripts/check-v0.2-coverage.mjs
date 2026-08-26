import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const result = {
    manifest: "test/fixtures/v0.2/coverage-manifest.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error("--manifest requires a path");
      result.manifest = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return result;
}

function repositoryPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(repositoryRoot, filePath);
}

function normalizedPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return {};

  const fields = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---") return fields;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    fields[key] = value;
  }

  return fields;
}

function markdownTableRows(content, heading) {
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex < 0) return [];

  const rows = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push(cells);
  }

  return rows;
}

function coverageRows(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => /^\|\s*V02-[A-Z0-9-]+\s*\|/.test(line))
    .map((line) => {
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      return { id: cells[0], owner: cells[2] };
    });
}

function primarySpecSource(content) {
  const match = content.match(/\*\*来源 Spec：\*\*\s+\[SOURCE:\s+([^\]#]+)(?:#[^\]]*)?\]/);
  return match?.[1]?.trim();
}

async function collectMarkdownFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

function compareRequirementMaps(manifestRequirements, sourceRequirements, errors) {
  const manifestMap = new Map();
  for (const requirement of manifestRequirements) {
    if (!requirement?.id || !requirement?.owner) {
      errors.push("coverage manifest contains a requirement without id or owner");
      continue;
    }
    if (manifestMap.has(requirement.id)) {
      errors.push(`coverage manifest repeats requirement ${requirement.id}`);
    }
    manifestMap.set(requirement.id, requirement.owner);
  }

  const sourceMap = new Map();
  for (const requirement of sourceRequirements) {
    if (sourceMap.has(requirement.id)) {
      errors.push(`S0 coverage table repeats requirement ${requirement.id}`);
    }
    sourceMap.set(requirement.id, requirement.owner);
  }

  for (const [id, owner] of sourceMap) {
    if (!manifestMap.has(id)) errors.push(`coverage manifest is missing ${id}`);
    else if (manifestMap.get(id) !== owner) {
      errors.push(`${id} owner differs: S0=${owner}, manifest=${manifestMap.get(id)}`);
    }
  }
  for (const id of manifestMap.keys()) {
    if (!sourceMap.has(id)) errors.push(`coverage manifest contains unknown requirement ${id}`);
  }
}

function parseAcceptanceRows(planContent, specification, errors) {
  const rows = markdownTableRows(planContent, "## 验收映射").filter((row) => {
    const firstCell = row[0] ?? "";
    return (
      firstCell !== "Acceptance ID" && firstCell !== "S0 验收组" && firstCell !== "Spec 验收组"
    );
  });

  if (rows.length !== specification.acceptances.length) {
    errors.push(
      `${specification.code} acceptance count differs: plan=${rows.length}, manifest=${specification.acceptances.length}`,
    );
    return;
  }

  const taskHeadings = new Set(
    [...planContent.matchAll(/^### Task (\d+)：/gm)].map((match) => Number(match[1])),
  );

  rows.forEach((row, index) => {
    const expected = specification.acceptances[index];
    const hasExplicitId = /^S\d-(?:A\d+|GATE)$/.test(row[0] ?? "");
    const actual = hasExplicitId
      ? {
          id: row[0],
          label: row[1],
          planTasks: row[2],
          planEvidence: row[3],
          planStatus: row[4],
        }
      : {
          id: expected.id,
          label: row[0],
          planTasks: row[1],
          planEvidence: row[2],
          planStatus: row[3],
        };

    for (const field of ["id", "label", "planTasks", "planEvidence", "planStatus"]) {
      if (actual[field] !== expected[field]) {
        errors.push(
          `${expected.id} ${field} differs: plan=${String(actual[field])}, manifest=${String(expected[field])}`,
        );
      }
    }

    if (
      !/^S\d-(?:A\d+|GATE)$/.test(expected.id) ||
      !expected.id.startsWith(`${specification.code}-`)
    ) {
      errors.push(`${expected.id} is not a stable acceptance ID for ${specification.code}`);
    }
    if (!/^Tasks?\s+\d/.test(expected.planTasks)) {
      errors.push(`${expected.id} has no Plan task binding`);
    }
    for (const taskNumber of expected.planTasks.match(/\d+/g)?.map(Number) ?? []) {
      if (!taskHeadings.has(taskNumber)) {
        errors.push(`${expected.id} references missing Task ${taskNumber}`);
      }
    }
    if (!expected.planEvidence) errors.push(`${expected.id} has no expected evidence`);
    if (
      !Array.isArray(expected.verificationEntrypoints) ||
      expected.verificationEntrypoints.length === 0
    ) {
      errors.push(`${expected.id} has no verification entrypoint`);
    }
  });
}

export async function checkCoverage({ manifestPath }) {
  const errors = [];
  const manifestAbsolutePath = repositoryPath(manifestPath);
  const manifest = JSON.parse(await readFile(manifestAbsolutePath, "utf8"));

  if (manifest.schemaVersion !== 1)
    errors.push(`unsupported manifest schema ${manifest.schemaVersion}`);

  const prdContent = await readFile(repositoryPath(manifest.prd.path), "utf8");
  const actualDigest = sha256(prdContent);
  const actualClauseCount = prdContent
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s+\S/.test(line)).length;
  if (actualDigest !== manifest.prd.sha256) {
    errors.push(`PRD digest differs: actual=${actualDigest}, manifest=${manifest.prd.sha256}`);
  }
  if (actualClauseCount !== manifest.prd.markdownListClauseCount) {
    errors.push(
      `PRD clause count differs: actual=${actualClauseCount}, manifest=${manifest.prd.markdownListClauseCount}`,
    );
  }

  const coverageSource = await readFile(repositoryPath(manifest.coverageSource), "utf8");
  const recordedBaseline = coverageSource.match(
    /SHA-256\s+`([a-f0-9]{64})`，包含\s+(\d+)\s+个 Markdown 列表条款/,
  );
  if (!recordedBaseline) {
    errors.push("S0 coverage source does not contain the recorded PRD digest and clause count");
  } else {
    if (recordedBaseline[1] !== manifest.prd.sha256) {
      errors.push(`S0 recorded PRD digest differs from manifest: ${recordedBaseline[1]}`);
    }
    if (Number(recordedBaseline[2]) !== manifest.prd.markdownListClauseCount) {
      errors.push(`S0 recorded PRD clause count differs from manifest: ${recordedBaseline[2]}`);
    }
  }

  compareRequirementMaps(manifest.requirements, coverageRows(coverageSource), errors);

  if (!Array.isArray(manifest.specifications) || manifest.specifications.length !== 10) {
    errors.push("coverage manifest must contain exactly S0-S9");
  }

  const allPlanFiles = [
    ...(await collectMarkdownFiles(repositoryPath("docs/execution/plans"))),
    ...(await collectMarkdownFiles(repositoryPath("docs/archive/plans"))),
  ];
  const planSources = new Map();
  for (const planFile of allPlanFiles) {
    const content = await readFile(planFile, "utf8");
    const source = primarySpecSource(content);
    if (!source) continue;
    const relativePlan = normalizedPath(path.relative(repositoryRoot, planFile));
    const plans = planSources.get(source) ?? [];
    plans.push(relativePlan);
    planSources.set(source, plans);
  }

  const specificationCodes = new Set();
  const acceptanceIds = new Set();
  for (const specification of manifest.specifications ?? []) {
    if (!/^S[0-9]$/.test(specification.code)) {
      errors.push(`invalid specification code ${specification.code}`);
    }
    if (specificationCodes.has(specification.code)) {
      errors.push(`coverage manifest repeats ${specification.code}`);
    }
    specificationCodes.add(specification.code);

    const specContent = await readFile(repositoryPath(specification.spec), "utf8");
    const planContent = await readFile(repositoryPath(specification.plan), "utf8");
    const specFrontmatter = parseFrontmatter(specContent);
    const planFrontmatter = parseFrontmatter(planContent);
    if (specFrontmatter.document_type !== "spec") {
      errors.push(`${specification.spec} is not a governed Spec`);
    }
    if (planFrontmatter.document_type !== "plan") {
      errors.push(`${specification.plan} is not a governed Plan`);
    }
    if (specFrontmatter.status !== planFrontmatter.status) {
      errors.push(
        `${specification.code} lifecycle differs: spec=${specFrontmatter.status}, plan=${planFrontmatter.status}`,
      );
    }
    if (!new Set(["active", "archived"]).has(specFrontmatter.status)) {
      errors.push(`${specification.code} is not active or archived`);
    }

    const source = primarySpecSource(planContent);
    if (source !== specification.spec) {
      errors.push(`${specification.plan} primary source differs: ${String(source)}`);
    }
    const matchingPlans = planSources.get(specification.spec) ?? [];
    if (matchingPlans.length !== 1 || matchingPlans[0] !== specification.plan) {
      errors.push(
        `${specification.code} must have exactly one lifecycle Plan; found ${matchingPlans.join(", ") || "none"}`,
      );
    }

    for (const acceptance of specification.acceptances) {
      if (acceptanceIds.has(acceptance.id)) {
        errors.push(`coverage manifest repeats acceptance ${acceptance.id}`);
      }
      acceptanceIds.add(acceptance.id);
    }
    parseAcceptanceRows(planContent, specification, errors);
  }

  for (let index = 0; index <= 9; index += 1) {
    if (!specificationCodes.has(`S${index}`)) errors.push(`coverage manifest is missing S${index}`);
  }

  return {
    acceptanceCount: acceptanceIds.size,
    errors,
    requirementCount: manifest.requirements.length,
    specificationCount: specificationCodes.size,
  };
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const result = await checkCoverage({ manifestPath: arguments_.manifest });
  if (result.errors.length > 0) {
    console.error("v0.2 coverage check failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `v0.2 coverage check passed for ${result.requirementCount} requirements, ${result.acceptanceCount} acceptance IDs, and ${result.specificationCount} Specs/Plans.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
