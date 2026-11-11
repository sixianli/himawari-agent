#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `用法：
  node scripts/operations/mcp-write-acceptance.mjs serve --dir <空目录> --host <监听地址> [--port <端口>]
  node scripts/operations/mcp-write-acceptance.mjs report --dir <同一目录>

serve：在 <空目录> 里新建一个只给验收用的 SQLite 库，用真实的 MCP 入口、记忆写入器和规则写入器
（P5-2，ADR 0225、0226）在 <监听地址> 上提供 /api/mcp/v1。只读令牌和写令牌随机生成，只写进
<目录>/read-token、<目录>/write-token（权限 600），不打印。
report：只读打开同一个库，列出外部提议的记忆、主人规则和对应的决策记录。
需要先运行 npm run build:node。`;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = path.join(repositoryRoot, "dist/node-runtime/node_modules");
const load = (name, file) => import(path.join(runtime, name, file));

const OWNER_ID = "owner-mcp-acceptance";
const AGENT_ID = "agent-mcp-acceptance";
const THREAD_ID = "thread-mcp-acceptance";
const GENERATION_ID = "generation-mcp-acceptance";
const TIME_ZONE = "Asia/Tokyo";
const PAYLOAD_KEY_REF = "mcp-acceptance-payload-key";

function options(argv) {
  const [mode, ...rest] = argv;
  const parsed = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!["--dir", "--host", "--port"].includes(key) || value === undefined) {
      throw new Error(`ARGUMENT_INVALID ${key ?? ""}\n${USAGE}`);
    }
    parsed[key.slice(2)] = value;
  }
  if (!["serve", "report"].includes(mode) || !parsed.dir || !path.isAbsolute(parsed.dir))
    throw new Error(`ARGUMENT_INVALID\n${USAGE}`);
  if (mode === "serve" && !parsed.host) throw new Error(`ARGUMENT_INVALID --host\n${USAGE}`);
  return parsed;
}

async function seed(databasePath, persistence) {
  const database = persistence.openQualifiedDatabase(databasePath);
  persistence.applyMigrations(database, await persistence.loadBundledMigrations());
  const now = new Date().toISOString();
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'open', ?, ?)`,
    )
    .run(THREAD_ID, OWNER_ID, AGENT_ID, now, now);
  database
    .prepare(
      `INSERT INTO thread_checkpoint_jobs (
        id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
        policy_version, status, attempt_count, requested_at
      ) VALUES ('checkpoint-mcp-acceptance', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
    )
    .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, now);
  database
    .prepare(
      `INSERT INTO memory_generations (
        id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
        model_descriptor_ref, policy_version, output_ref
      ) VALUES (?, 'checkpoint-mcp-acceptance', ?, ?, ?, 'completed', 'acceptance', 'memory-policy-v1', NULL)`,
    )
    .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
  database.close();
}

async function writeSecret(file, value) {
  await writeFile(file, value, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
}

async function serve(input) {
  const [application, memoryEngine, persistence, platform, agent] = await Promise.all([
    load("@himawari-agent/application", "dist/index.js"),
    load("@himawari-agent/memory-engine", "dist/index.js"),
    load("@himawari-agent/persistence-sqlite", "dist/index.js"),
    load("@himawari-agent/platform-node", "dist/index.js"),
    Promise.all([
      load("@himawari-agent/agent-service", "dist/production-mcp-read.js"),
      load("@himawari-agent/agent-service", "dist/production-mcp-memory-writer.js"),
      load("@himawari-agent/agent-service", "dist/production-owner-rules.js"),
      load("@himawari-agent/agent-service", "dist/production-mcp-rule-writer.js"),
      load("@himawari-agent/agent-service", "dist/production-reminder-writer.js"),
    ]),
  ]);
  const [mcpRead, memoryWriter, ownerRules, ruleWriter, reminderWriter] = agent;
  const { default: Fastify } = await import(path.join(runtime, "fastify/fastify.js"));
  const stateRoot = path.join(input.dir, "state");
  await mkdir(stateRoot, { recursive: false, mode: 0o700 });
  const readSecret = randomBytes(32).toString("hex");
  const writeSecretValue = randomBytes(32).toString("hex");
  const payloadKey = randomBytes(32);
  await writeSecret(path.join(input.dir, "read-token"), readSecret);
  await writeSecret(path.join(input.dir, "write-token"), writeSecretValue);
  await seed(path.join(stateRoot, "product.sqlite"), persistence);
  const clock = { now: () => new Date().toISOString() };
  const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
  const repository = await persistence.SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  const protector = new platform.EnvelopePayloadProtector({
    keys: {
      kind: "memory-development",
      productionSuitable: false,
      resolve: async () => new Uint8Array(payloadKey),
    },
    activeKey: { keyRef: PAYLOAD_KEY_REF, kekVersion: "v1", dekVersion: "dek-v1" },
  });
  const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
  const readText = async (ref) => {
    const payload = await payloads.get(ref);
    if (!payload) throw new Error("MEMORY_PAYLOAD_MISSING");
    return new TextDecoder().decode(await protector.unprotect({ payload }));
  };
  const provider = new memoryEngine.HybridMemoryProvider({
    index: repository.memoryIndex(),
    embedder: {
      model: "acceptance-no-embedding",
      dimensions: 2,
      embed: async () => {
        throw new Error("EMBEDDING_NOT_PART_OF_THIS_ACCEPTANCE");
      },
    },
    embeddableClassifications: ["public", "private", "sensitive"],
    minimumSimilarity: 0.45,
    now: () => clock.now(),
  });
  const memory = new application.DurableMemoryService({
    state: repository.productMemoryState(),
    jobs: repository.memoryProjectionJobs(),
    provider,
    content: { readText },
    workerId: "mcp-acceptance-worker",
    now: () => clock.now(),
  });
  const reminders = new reminderWriter.ProductionReminderWriter({
    configuration: scope,
    memory,
    state: repository.productMemoryState(),
    book: repository.memoryBook(),
    reminders: repository.memoryReminders(),
    payloads,
    protector,
    clock,
    timeZone: TIME_ZONE,
  });
  const failures = (event) => (error) =>
    process.stderr.write(`${JSON.stringify({ event, code: error?.code ?? error?.message })}\n`);
  const ledger = repository.decisionLedger();
  const proposals = new memoryWriter.ProductionMcpMemoryWriter({
    configuration: scope,
    memory,
    state: repository.productMemoryState(),
    book: repository.memoryBook(),
    ledger,
    payloads,
    protector,
    clock,
  });
  const rules = new ownerRules.ProductionOwnerRuleWriter({
    configuration: scope,
    rules: repository.ownerRules(),
    memory,
    memories: repository.productMemoryState(),
    book: repository.memoryBook(),
    threads: repository.threadRepository(),
    payloads,
    protector,
    clock,
  });
  const settingsStore = repository.proactive();
  const mcp = new mcpRead.ProductionMcpRead({
    scope,
    clock,
    secret: readSecret,
    write: {
      secret: writeSecretValue,
      proposals,
      rules: new ruleWriter.ProductionMcpRuleWriter({
        configuration: scope,
        rules,
        payloads,
        protector,
        clock,
        onFailure: failures("mcp-rule.marker-failed"),
      }),
    },
    timeZone: TIME_ZONE,
    requestTimeoutMs: 30_000,
    sources: {
      recall: async () => {
        throw new Error("RECALL_NOT_PART_OF_THIS_ACCEPTANCE");
      },
      embedOutsideRun: async (_context, operation) => operation(),
      reminders: (windowMs) => reminders.list(windowMs),
      settings: () => settingsStore.readSettings(scope),
    },
    ledger,
    onFailure: failures("mcp-read.failed"),
    onSummariesFailed: failures("mcp-read.summaries-failed"),
  });
  const app = Fastify({ logger: false });
  mcpRead.registerMcpReadRoute(app, mcp);
  await app.listen({ host: input.host, port: Number(input.port ?? 0) });
  const { port } = app.server.address();
  process.stdout.write(
    `MCP_ACCEPTANCE_LISTENING http://${input.host}:${port}${mcpRead.MCP_READ_PATH}\n`,
  );
  const stop = async () => {
    await app.close();
    await repository.close();
    process.stdout.write("MCP_ACCEPTANCE_STOPPED\n");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function report(input) {
  const { default: Database } = await import(path.join(runtime, "better-sqlite3/lib/index.js"));
  const database = new Database(path.join(input.dir, "state", "product.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  const rows = (sql) => database.prepare(sql).all();
  const result = {
    externalMemories: rows(
      `SELECT id, status, classification FROM memory_records
       WHERE id LIKE 'memory:mcp:%' OR id LIKE 'memory:rule:mcp:%' ORDER BY id`,
    ),
    ownerRules: rows(
      `SELECT rule_id, status, source, source_memory_id, parameters FROM rule_book_rules
       WHERE rule_id LIKE 'owner:%' ORDER BY rule_id`,
    ),
    decisions: rows(
      `SELECT kind, outcome, reason_code, subject_ref FROM decision_ledger
       WHERE reason_code LIKE 'mcp!_proposal!_%' ESCAPE '!' ORDER BY checked_at`,
    ),
    rulePayloads: rows(
      `SELECT ref FROM payloads WHERE ref LIKE 'rule-%' OR ref LIKE 'memory-content:%mcp:%' ORDER BY ref`,
    ).map(({ ref }) => ref),
  };
  database.close();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const input = options(process.argv.slice(2));
await (input.mode === "serve" ? serve(input) : report(input));
