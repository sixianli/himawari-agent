import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hardcodedLimits, scan } from "../../scripts/check-multi-user-exec.mjs";
import {
  acquireLock,
  enableSockets,
  releaseLock,
  undoSockets,
} from "../../scripts/operations/multi-user-exec/exec-accounts.mjs";
import {
  addSlot,
  directoryPlan,
  emptyLedger,
  knownUnitNames,
  parseExecConfig,
  parseLedger,
  personPaths,
  removeSlot,
  renderTmpfiles,
  renderUnits,
} from "../../scripts/operations/multi-user-exec/plan.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repository, "scripts/operations/multi-user-exec/exec-accounts.mjs");

function config(overrides = {}) {
  return {
    privateRoots: "/var/lib/himawari/j",
    workspaceRoots: "/var/lib/himawari/work",
    socketDirectory: "/run/himawari/exec",
    serviceAccount: "himawari-prod",
    peopleGroup: "himawari-people",
    uids: { first: 61001, last: 61003 },
    gateway: {
      node: "/opt/himawari/node/bin/node",
      entry: "/opt/himawari/gateway.js",
      idleExitMs: 3600123,
    },
    allPeople: { MemoryMax: "7001M", MemoryHigh: "6002M", CPUQuota: "303%", TasksMax: "4004" },
    person: {
      MemoryMax: "1505M",
      MemoryHigh: "1206M",
      CPUQuota: "107%",
      TasksMax: "508",
      LimitNOFILE: "4109",
    },
    people: { bobbyb: { MemoryMax: "2510M", TasksMax: "611" } },
    ...overrides,
  };
}

function settings(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

describe("multi-user exec configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseExecConfig(config()).person.MemoryMax).toBe("1505M");
  });

  it.each([
    "privateRoots",
    "workspaceRoots",
    "socketDirectory",
    "serviceAccount",
    "peopleGroup",
    "uids",
    "gateway",
    "allPeople",
    "person",
    "people",
  ])("refuses a configuration without %s", (key) => {
    const value = config();
    delete value[key];
    expect(() => parseExecConfig(value)).toThrow(`EXEC_CONFIG_MISSING $.${key}`);
  });

  it.each(["MemoryMax", "MemoryHigh", "CPUQuota", "TasksMax", "LimitNOFILE"])(
    "refuses a person default without %s",
    (key) => {
      const value = config();
      delete value.person[key];
      expect(() => parseExecConfig(value)).toThrow(`EXEC_CONFIG_MISSING $.person.${key}`);
    },
  );

  it.each([
    [{ extra: 1 }, "EXEC_CONFIG_UNKNOWN $.extra"],
    [{ privateRoots: "/var/lib/himawari/private-roots" }, "EXEC_CONFIG_PRIVATE_ROOT_TOO_LONG"],
    [{ privateRoots: "relative" }, "EXEC_CONFIG_PATH_INVALID $.privateRoots"],
    [{ workspaceRoots: "/var/lib/himawari/j/w" }, "EXEC_CONFIG_PATHS_OVERLAP"],
    [{ uids: { first: 61003, last: 61001 } }, "EXEC_CONFIG_UID_INVALID $.uids"],
    [{ serviceAccount: "root" }, "EXEC_CONFIG_ACCOUNT_INVALID $.serviceAccount"],
    [{ peopleGroup: "sudo" }, "EXEC_CONFIG_ACCOUNT_INVALID $.peopleGroup"],
    [{ peopleGroup: "hx-andyaa" }, "EXEC_CONFIG_ACCOUNT_INVALID $.peopleGroup"],
    [{ peopleGroup: "docker" }, "EXEC_CONFIG_ACCOUNT_INVALID $.peopleGroup"],
    [{ serviceAccount: "hx-andyaa" }, "EXEC_CONFIG_ACCOUNT_INVALID $.serviceAccount"],
    [
      { socketDirectory: `/run/himawari/${"s".repeat(100)}` },
      "EXEC_CONFIG_SOCKET_PATH_TOO_LONG $.socketDirectory",
    ],
    [{ people: { "Bad-Slot": {} } }, "EXEC_CONFIG_SLOT_INVALID"],
    [{ people: { bobbyb: { Swap: "1G" } } }, "EXEC_CONFIG_UNKNOWN $.people.bobbyb.Swap"],
    [{ people: { bobbyb: { MemoryHigh: "9G" } } }, "EXEC_CONFIG_LIMIT_INVALID $.people.bobbyb"],
    [
      { person: { ...config().person, CPUQuota: "1.5" } },
      "EXEC_CONFIG_LIMIT_INVALID $.person.CPUQuota",
    ],
    [{ gateway: { ...config().gateway, idleExitMs: 0 } }, "EXEC_CONFIG_LIMIT_INVALID"],
    [
      { gateway: { ...config().gateway, idleExitMs: 1_000_000_000 } },
      "EXEC_CONFIG_LIMIT_INVALID $.gateway.idleExitMs",
    ],
    [
      { gateway: { ...config().gateway, entry: "/var/lib/himawari/work/andyaa/gateway.js" } },
      "EXEC_CONFIG_GATEWAY_IN_PERSON_PATH $.gateway.entry",
    ],
    [
      { person: { ...config().person, MemoryMax: "8G" } },
      "EXEC_CONFIG_LIMIT_INVALID $.person.MemoryMax",
    ],
    [
      { people: { bobbyb: { MemoryMax: "8G" } } },
      "EXEC_CONFIG_LIMIT_INVALID $.people.bobbyb.MemoryMax",
    ],
  ])("refuses %j", (change, code) => {
    expect(() => parseExecConfig(config(change))).toThrow(code);
  });
});

describe("multi-user exec slot ledger", () => {
  it("gives each new slot the first unused uid and never reuses a removed slot or uid", () => {
    const parsed = parseExecConfig(config());
    let ledger = addSlot(emptyLedger(), parsed, "andyaa");
    ledger = addSlot(ledger, parsed, "bobbyb");
    ledger = removeSlot(ledger, "andyaa");
    expect(() => addSlot(ledger, parsed, "andyaa")).toThrow("EXEC_SLOT_USED andyaa");
    ledger = addSlot(ledger, parsed, "carolc");
    expect(ledger.slots).toEqual([
      { slot: "andyaa", uid: 61001, state: "removed" },
      { slot: "bobbyb", uid: 61002, state: "active" },
      { slot: "carolc", uid: 61003, state: "active" },
    ]);
    expect(() => addSlot(ledger, parsed, "davidd")).toThrow("EXEC_UIDS_EXHAUSTED");
    expect(parseLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
  });

  it.each(["abc", "1abcde", "ABCDEF", "abcdefg", "abc-de"])("refuses slot %s", (slot) => {
    expect(() => addSlot(emptyLedger(), parseExecConfig(config()), slot)).toThrow(
      "EXEC_SLOT_INVALID",
    );
  });

  it("refuses a ledger uid below the system range", () => {
    expect(() =>
      parseLedger({ version: 1, slots: [{ slot: "andyaa", uid: 0, state: "active" }] }),
    ).toThrow("EXEC_LEDGER_INVALID");
  });

  it("refuses a ledger uid above the system range", () => {
    expect(() =>
      parseLedger({ version: 1, slots: [{ slot: "andyaa", uid: 2 ** 31, state: "removed" }] }),
    ).toThrow("EXEC_LEDGER_INVALID");
  });

  it("refuses a ledger that reuses a uid", () => {
    expect(() =>
      parseLedger({
        version: 1,
        slots: [
          { slot: "andyaa", uid: 61001, state: "removed" },
          { slot: "bobbyb", uid: 61001, state: "active" },
        ],
      }),
    ).toThrow("EXEC_LEDGER_INVALID");
  });
});

describe("multi-user exec units", () => {
  const parsed = parseExecConfig(config());
  const ledger = removeSlot(
    addSlot(addSlot(addSlot(emptyLedger(), parsed, "andyaa"), parsed, "bobbyb"), parsed, "carolc"),
    "carolc",
  );
  const units = renderUnits(parsed, ledger);

  it("takes every limit from the configuration, with per-person overrides", () => {
    expect(settings(units.get("himawari-exec.slice"))).toMatchObject({
      ...config().allPeople,
      MemorySwapMax: "0",
    });
    const { LimitNOFILE, ...personSlice } = config().person;
    expect(settings(units.get("himawari-exec-andyaa.slice"))).toMatchObject({
      ...personSlice,
      MemorySwapMax: "0",
    });
    expect(settings(units.get("himawari-exec-bobbyb.slice"))).toMatchObject({
      ...personSlice,
      MemoryMax: "2510M",
      TasksMax: "611",
    });
    expect(settings(units.get("himawari-exec-andyaa.service")).LimitNOFILE).toBe(LimitNOFILE);
  });

  it("lets only the service account reach a person's socket and runs the gateway as that person", () => {
    expect(settings(units.get("himawari-exec-andyaa.socket"))).toMatchObject({
      ListenStream: "/run/himawari/exec/andyaa.sock",
      Accept: "no",
      SocketUser: "himawari-prod",
      SocketGroup: "himawari-prod",
      SocketMode: "0600",
      Service: "himawari-exec-andyaa.service",
    });
    expect(settings(units.get("himawari-exec-andyaa.service"))).toMatchObject({
      User: "hx-andyaa",
      Group: "hx-andyaa",
      Slice: "himawari-exec-andyaa.slice",
      ExecStart:
        "/opt/himawari/node/bin/node /opt/himawari/gateway.js --idle-exit-ms 3600123 --control-root /var/lib/himawari/j/andyaa",
      KillMode: "control-group",
      OOMPolicy: "kill",
      ProtectSystem: "strict",
      ReadWritePaths: "/var/lib/himawari/j/andyaa /var/lib/himawari/work/andyaa",
    });
  });

  it("renders nothing for a removed person but still knows its unit names", () => {
    expect([...units.keys()].filter((name) => name.includes("carolc"))).toEqual([]);
    expect(knownUnitNames(ledger)).toEqual(
      new Set([
        "himawari-exec.slice",
        ...["andyaa", "bobbyb", "carolc"].flatMap((slot) => [
          `himawari-exec-${slot}.slice`,
          `himawari-exec-${slot}.socket`,
          `himawari-exec-${slot}.service`,
        ]),
      ]),
    );
  });

  it("recreates the socket directory for the service account after a reboot", () => {
    expect(renderTmpfiles(parsed)).toBe("d /run/himawari/exec 0750 root himawari-prod -\n");
  });

  it("keeps private roots to the person and shares workspaces only with the people group", () => {
    expect(directoryPlan(parsed, ledger)).toEqual([
      { path: "/var/lib/himawari/j", owner: "root", group: "root", mode: "0755" },
      { path: "/var/lib/himawari/work", owner: "root", group: "root", mode: "0755" },
      { path: "/run/himawari/exec", owner: "root", group: "himawari-prod", mode: "0750" },
      { path: "/var/lib/himawari/j/andyaa", owner: "hx-andyaa", group: "hx-andyaa", mode: "0700" },
      {
        path: "/var/lib/himawari/work/andyaa",
        owner: "hx-andyaa",
        group: "himawari-people",
        mode: "2770",
      },
      { path: "/var/lib/himawari/j/bobbyb", owner: "hx-bobbyb", group: "hx-bobbyb", mode: "0700" },
      {
        path: "/var/lib/himawari/work/bobbyb",
        owner: "hx-bobbyb",
        group: "himawari-people",
        mode: "2770",
      },
    ]);
    expect(Buffer.byteLength(personPaths(parsed, "andyaa").privateRoot)).toBeLessThanOrEqual(27);
  });

  it("prints the plan from the command line without root", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "multi-user-exec-"));
    writeFileSync(path.join(directory, "exec.json"), JSON.stringify(config()));
    writeFileSync(path.join(directory, "slots.json"), JSON.stringify(ledger));
    const printed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cli,
          "plan",
          "--config",
          path.join(directory, "exec.json"),
          "--ledger",
          path.join(directory, "slots.json"),
        ],
        { encoding: "utf8" },
      ),
    );
    expect(printed.units["himawari-exec-bobbyb.slice"]).toBe(
      units.get("himawari-exec-bobbyb.slice"),
    );
  });

  it("refuses to change anything when the slot ledger is missing", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "multi-user-exec-"));
    writeFileSync(path.join(directory, "exec.json"), JSON.stringify(config()));
    const missing = path.join(directory, "slots.json");
    for (const command of [["apply"], ["remove", "andyaa"], ["add", "andyaa"]])
      expect(() =>
        execFileSync(
          process.execPath,
          [cli, ...command, "--config", path.join(directory, "exec.json"), "--ledger", missing],
          { encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow(`EXEC_LEDGER_MISSING ${missing}`);
  });
});

describe("check:multi-user-exec", () => {
  it("finds no limit written into the provisioning tool", () => {
    expect(scan(repository)).toEqual([]);
  });

  it("finds a limit written into any file under the tool, nested ones included", () => {
    const root = mkdtempSync(path.join(tmpdir(), "multi-user-exec-scan-"));
    mkdirSync(path.join(root, "scripts/operations/multi-user-exec/templates"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts/operations/multi-user-exec/plan.mjs"),
      "MemorySwapMax=0\n",
    );
    writeFileSync(
      path.join(root, "scripts/operations/multi-user-exec/templates/person.slice"),
      "[Slice]\nMemoryMax=2G\n",
    );
    expect(scan(root)).toEqual([
      "MULTI_USER_EXEC_LIMIT_HARDCODED scripts/operations/multi-user-exec/templates/person.slice MemoryMax=2",
    ]);
  });

  it("catches a limit written into a unit template", () => {
    expect(hardcodedLimits('"MemoryMax=2G",\nTasksMax=@TASKS@\nMemorySwapMax=0')).toEqual([
      "MemoryMax=2",
    ]);
    expect(hardcodedLimits("CPUQuota = 150%\nLimitNOFILE=infinity")).toEqual([
      "CPUQuota = 1",
      "LimitNOFILE=infinity",
    ]);
  });
});

describe("multi-user exec socket rollback and lock", () => {
  const ledger = {
    version: 1,
    slots: [
      { slot: "andyaa", uid: 61001, state: "active" },
      { slot: "bobbyb", uid: 61002, state: "active" },
      { slot: "carlcc", uid: 61003, state: "active" },
    ],
  };

  function fakeSystemctl(state, failing) {
    const calls = [];
    const probe = (args) => {
      const unit = args[2];
      if (args[0] === "is-active") return state[unit]?.active === true;
      if (args[0] === "is-enabled") return state[unit]?.enabled === true;
      return false;
    };
    return {
      calls,
      io: {
        quiet: (_command, args) => {
          calls.push(args.join(" "));
          return args[0] === "is-active" || args[0] === "is-enabled" ? probe(args) : true;
        },
        run: (_command, args) => {
          calls.push(args.join(" "));
          if (failing && args[2] === failing) throw new Error("ENABLE_FAILED");
        },
      },
    };
  }

  it("leaves sockets that were already running when a later enable fails", () => {
    const state = {
      "himawari-exec-andyaa.socket": { active: true, enabled: true },
      "himawari-exec-bobbyb.socket": { active: true, enabled: false },
    };
    const { calls, io } = fakeSystemctl(state, "himawari-exec-carlcc.socket");
    const changed = [];
    expect(() => enableSockets(ledger, io, changed)).toThrow("ENABLE_FAILED");
    undoSockets(changed, io);
    expect(calls).not.toContain("disable --now himawari-exec-andyaa.socket");
    expect(calls).not.toContain("disable --now himawari-exec-bobbyb.socket");
    expect(calls).toContain("disable himawari-exec-bobbyb.socket");
  });

  it("only stops a socket that was enabled but not running", () => {
    const state = { "himawari-exec-andyaa.socket": { active: false, enabled: true } };
    const { calls, io } = fakeSystemctl(state, "himawari-exec-andyaa.socket");
    const changed = [];
    expect(() => enableSockets(ledger, io, changed)).toThrow("ENABLE_FAILED");
    undoSockets(changed, io);
    expect(calls).toContain("stop himawari-exec-andyaa.socket");
    expect(calls.filter((call) => call.startsWith("disable") && call.includes("andyaa"))).toEqual(
      [],
    );
  });

  it("records the change before enable throws so rollback covers it", () => {
    const { calls, io } = fakeSystemctl({}, "himawari-exec-andyaa.socket");
    const changed = [];
    expect(() => enableSockets(ledger, io, changed)).toThrow("ENABLE_FAILED");
    undoSockets(changed, io);
    expect(calls).toContain("disable --now himawari-exec-andyaa.socket");
  });

  it("stops a socket this run started", () => {
    const { calls, io } = fakeSystemctl({}, "himawari-exec-bobbyb.socket");
    const changed = [];
    expect(() => enableSockets(ledger, io, changed)).toThrow("ENABLE_FAILED");
    undoSockets(changed, io);
    expect(calls).toContain("disable --now himawari-exec-andyaa.socket");
  });

  it("keeps a lock that no longer holds our pid and survives a missing lock", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hx-lock-"));
    const lock = path.join(directory, "slots.json.lock");
    const held = acquireLock(lock);
    writeFileSync(lock, "1\n");
    releaseLock(lock, held);
    expect(readFileSync(lock, "utf8")).toBe("1\n");
    const second = openSync(path.join(directory, "other"), "w");
    expect(() => releaseLock(path.join(directory, "missing"), second)).not.toThrow();
    expect(existsSync(path.join(directory, "missing"))).toBe(false);
  });

  it("removes its own lock and refuses a live one", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hx-lock-"));
    const lock = path.join(directory, "slots.json.lock");
    const held = acquireLock(lock);
    expect(() => acquireLock(lock)).toThrow("EXEC_LOCKED");
    releaseLock(lock, held);
    expect(existsSync(lock)).toBe(false);
  });
});
