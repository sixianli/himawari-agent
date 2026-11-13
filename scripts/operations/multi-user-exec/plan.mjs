import path from "node:path";

export const SLOT_PATTERN = /^[a-z][a-z0-9]{5}$/;
export const PRIVATE_ROOT_MAX_BYTES = 27;
export const SLICE = "himawari-exec.slice";
export const MIN_UID = 1000;
const IDLE_EXIT_MS = /^[1-9][0-9]{0,8}$/;
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const SIZE = /^[1-9][0-9]{0,8}[KMGT]$/;
const PERCENT = /^[1-9][0-9]{0,4}%$/;
const COUNT = /^[1-9][0-9]{0,8}$/;
const PERSON_LIMITS = {
  MemoryMax: SIZE,
  MemoryHigh: SIZE,
  CPUQuota: PERCENT,
  TasksMax: COUNT,
  LimitNOFILE: COUNT,
};
const ALL_PEOPLE_LIMITS = { MemoryMax: SIZE, MemoryHigh: SIZE, CPUQuota: PERCENT, TasksMax: COUNT };
const UNITS_IN_BYTES = { K: 1n << 10n, M: 1n << 20n, G: 1n << 30n, T: 1n << 40n };

function fail(code, detail) {
  throw new Error(detail === undefined ? code : `${code} ${detail}`);
}

function record(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("EXEC_CONFIG_INVALID", where);
  return value;
}

function exactKeys(value, keys, where) {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) fail("EXEC_CONFIG_MISSING", `${where}.${missing[0]}`);
  if (extra.length > 0) fail("EXEC_CONFIG_UNKNOWN", `${where}.${extra[0]}`);
}

function absolute(value, where) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value === "/" ||
    /[\s"'\\$`%]/.test(value)
  )
    fail("EXEC_CONFIG_PATH_INVALID", where);
  return value;
}

function account(value, where) {
  if (typeof value !== "string" || !ACCOUNT.test(value)) fail("EXEC_CONFIG_ACCOUNT_INVALID", where);
  return value;
}

function uid(value, where) {
  if (!Number.isSafeInteger(value) || value < MIN_UID || value > 2 ** 31 - 2)
    fail("EXEC_CONFIG_UID_INVALID", where);
  return value;
}

function limits(value, shape, where, partial) {
  const raw = record(value, where);
  for (const key of Object.keys(raw))
    if (!(key in shape)) fail("EXEC_CONFIG_UNKNOWN", `${where}.${key}`);
  if (!partial)
    for (const key of Object.keys(shape))
      if (!(key in raw)) fail("EXEC_CONFIG_MISSING", `${where}.${key}`);
  for (const [key, text] of Object.entries(raw))
    if (typeof text !== "string" || !shape[key].test(text))
      fail("EXEC_CONFIG_LIMIT_INVALID", `${where}.${key}`);
  return Object.freeze({ ...raw });
}

function bytes(size) {
  return BigInt(size.slice(0, -1)) * UNITS_IN_BYTES[size.slice(-1)];
}

function memoryOrdered(set, where, ceiling) {
  if (bytes(set.MemoryHigh) > bytes(set.MemoryMax))
    fail("EXEC_CONFIG_LIMIT_INVALID", `${where}.MemoryHigh`);
  if (ceiling && bytes(set.MemoryMax) > bytes(ceiling.MemoryMax))
    fail("EXEC_CONFIG_LIMIT_INVALID", `${where}.MemoryMax`);
}

function inside(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}

export function parseExecConfig(value) {
  const raw = record(value, "$");
  exactKeys(
    raw,
    [
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
    ],
    "$",
  );
  const privateRoots = absolute(raw.privateRoots, "$.privateRoots");
  const workspaceRoots = absolute(raw.workspaceRoots, "$.workspaceRoots");
  const socketDirectory = absolute(raw.socketDirectory, "$.socketDirectory");
  if (Buffer.byteLength(path.join(privateRoots, "a".repeat(6))) > PRIVATE_ROOT_MAX_BYTES)
    fail("EXEC_CONFIG_PRIVATE_ROOT_TOO_LONG", "$.privateRoots");
  const roots = [privateRoots, workspaceRoots, socketDirectory];
  for (const [index, first] of roots.entries())
    for (const second of roots.slice(index + 1))
      if (first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`))
        fail("EXEC_CONFIG_PATHS_OVERLAP", `${first} ${second}`);
  const uids = record(raw.uids, "$.uids");
  exactKeys(uids, ["first", "last"], "$.uids");
  if (uid(uids.first, "$.uids.first") > uid(uids.last, "$.uids.last"))
    fail("EXEC_CONFIG_UID_INVALID", "$.uids");
  const gateway = record(raw.gateway, "$.gateway");
  exactKeys(gateway, ["node", "entry", "idleExitMs"], "$.gateway");
  if (!Number.isSafeInteger(gateway.idleExitMs) || !IDLE_EXIT_MS.test(String(gateway.idleExitMs)))
    fail("EXEC_CONFIG_LIMIT_INVALID", "$.gateway.idleExitMs");
  const allPeople = limits(raw.allPeople, ALL_PEOPLE_LIMITS, "$.allPeople", false);
  memoryOrdered(allPeople, "$.allPeople");
  const person = limits(raw.person, PERSON_LIMITS, "$.person", false);
  const people = record(raw.people, "$.people");
  const overrides = {};
  for (const [slot, override] of Object.entries(people)) {
    if (!SLOT_PATTERN.test(slot)) fail("EXEC_CONFIG_SLOT_INVALID", `$.people.${slot}`);
    overrides[slot] = limits(override, PERSON_LIMITS, `$.people.${slot}`, true);
    memoryOrdered({ ...person, ...overrides[slot] }, `$.people.${slot}`, allPeople);
  }
  memoryOrdered(person, "$.person", allPeople);
  const node = absolute(gateway.node, "$.gateway.node");
  const entry = absolute(gateway.entry, "$.gateway.entry");
  for (const [where, file] of [
    ["$.gateway.node", node],
    ["$.gateway.entry", entry],
  ])
    if (roots.some((root) => inside(file, root))) fail("EXEC_CONFIG_GATEWAY_IN_PERSON_PATH", where);
  return Object.freeze({
    privateRoots,
    workspaceRoots,
    socketDirectory,
    serviceAccount: account(raw.serviceAccount, "$.serviceAccount"),
    peopleGroup: account(raw.peopleGroup, "$.peopleGroup"),
    uids: Object.freeze({ first: uids.first, last: uids.last }),
    gateway: Object.freeze({
      node,
      entry,
      idleExitMs: gateway.idleExitMs,
    }),
    allPeople,
    person,
    people: Object.freeze(overrides),
  });
}

export function emptyLedger() {
  return { version: 1, slots: [] };
}

export function parseLedger(value) {
  const raw = record(value, "ledger");
  exactKeys(raw, ["version", "slots"], "ledger");
  if (raw.version !== 1 || !Array.isArray(raw.slots)) fail("EXEC_LEDGER_INVALID");
  const seenSlots = new Set();
  const seenUids = new Set();
  const slots = raw.slots.map((entry, index) => {
    const item = record(entry, `ledger.slots[${index}]`);
    exactKeys(item, ["slot", "uid", "state"], `ledger.slots[${index}]`);
    if (
      !SLOT_PATTERN.test(item.slot) ||
      !Number.isSafeInteger(item.uid) ||
      item.uid < MIN_UID ||
      !["active", "removed"].includes(item.state) ||
      seenSlots.has(item.slot) ||
      seenUids.has(item.uid)
    )
      fail("EXEC_LEDGER_INVALID", `ledger.slots[${index}]`);
    seenSlots.add(item.slot);
    seenUids.add(item.uid);
    return Object.freeze({ slot: item.slot, uid: item.uid, state: item.state });
  });
  return Object.freeze({ version: 1, slots: Object.freeze(slots) });
}

export function addSlot(ledger, config, slot) {
  if (typeof slot !== "string" || !SLOT_PATTERN.test(slot)) fail("EXEC_SLOT_INVALID", slot);
  if (ledger.slots.some((entry) => entry.slot === slot)) fail("EXEC_SLOT_USED", slot);
  const used = new Set(ledger.slots.map((entry) => entry.uid));
  let next = config.uids.first;
  while (used.has(next)) next += 1;
  if (next > config.uids.last) fail("EXEC_UIDS_EXHAUSTED");
  return Object.freeze({
    version: 1,
    slots: Object.freeze([...ledger.slots, Object.freeze({ slot, uid: next, state: "active" })]),
  });
}

export function removeSlot(ledger, slot) {
  const entry = ledger.slots.find((item) => item.slot === slot);
  if (!entry || entry.state !== "active") fail("EXEC_SLOT_NOT_ACTIVE", slot);
  return Object.freeze({
    version: 1,
    slots: Object.freeze(
      ledger.slots.map((item) =>
        item.slot === slot ? Object.freeze({ ...item, state: "removed" }) : item,
      ),
    ),
  });
}

export const accountName = (slot) => `hx-${slot}`;
export const sliceName = (slot) => `himawari-exec-${slot}.slice`;
export const socketName = (slot) => `himawari-exec-${slot}.socket`;
export const serviceName = (slot) => `himawari-exec-${slot}.service`;

export function personPaths(config, slot) {
  return Object.freeze({
    privateRoot: path.join(config.privateRoots, slot),
    workspace: path.join(config.workspaceRoots, slot),
    socket: path.join(config.socketDirectory, `${slot}.sock`),
  });
}

function lines(settings) {
  return Object.entries(settings).map(([key, value]) => `${key}=${value}`);
}

function unit(sections) {
  return `${sections
    .map(([name, entries]) => [`[${name}]`, ...entries].join("\n"))
    .join("\n\n")}\n`;
}

export function renderUnits(config, ledger) {
  const files = new Map();
  files.set(
    SLICE,
    unit([
      [
        "Unit",
        ["Description=Limits shared by every person's Himawari commands", "Before=slices.target"],
      ],
      ["Slice", [...lines(config.allPeople), "MemorySwapMax=0"]],
    ]),
  );
  for (const entry of ledger.slots) {
    if (entry.state !== "active") continue;
    const { slot } = entry;
    const limitsForSlot = { ...config.person, ...(config.people[slot] ?? {}) };
    const { LimitNOFILE, ...sliceLimits } = limitsForSlot;
    const paths = personPaths(config, slot);
    const user = accountName(slot);
    files.set(
      sliceName(slot),
      unit([
        ["Unit", [`Description=Limits for Himawari commands of ${slot}`, "Before=slices.target"]],
        ["Slice", [...lines(sliceLimits), "MemorySwapMax=0"]],
      ]),
    );
    files.set(
      socketName(slot),
      unit([
        ["Unit", [`Description=Job Host gateway socket for ${slot}`]],
        [
          "Socket",
          [
            `ListenStream=${paths.socket}`,
            "Accept=no",
            `SocketUser=${config.serviceAccount}`,
            `SocketGroup=${config.serviceAccount}`,
            "SocketMode=0600",
            "RemoveOnStop=yes",
            `Service=${serviceName(slot)}`,
          ],
        ],
        ["Install", ["WantedBy=sockets.target"]],
      ]),
    );
    files.set(
      serviceName(slot),
      unit([
        [
          "Unit",
          [
            `Description=Job Host gateway for ${slot}`,
            `Requires=${socketName(slot)}`,
            `After=${socketName(slot)}`,
          ],
        ],
        [
          "Service",
          [
            "Type=simple",
            `Slice=${sliceName(slot)}`,
            `User=${user}`,
            `Group=${user}`,
            `ExecStart=${config.gateway.node} ${config.gateway.entry} --idle-exit-ms ${config.gateway.idleExitMs} --control-root ${paths.privateRoot}`,
            "KillMode=control-group",
            "OOMPolicy=kill",
            `LimitNOFILE=${LimitNOFILE}`,
            "UMask=0007",
            "NoNewPrivileges=yes",
            "PrivateTmp=yes",
            "ProtectSystem=strict",
            "ProtectHome=yes",
            "ProtectKernelModules=yes",
            "ProtectControlGroups=yes",
            `ReadWritePaths=${paths.privateRoot} ${paths.workspace}`,
          ],
        ],
      ]),
    );
  }
  return files;
}

export function directoryPlan(config, ledger) {
  const plan = [
    { path: config.privateRoots, owner: "root", group: "root", mode: "0755" },
    { path: config.workspaceRoots, owner: "root", group: "root", mode: "0755" },
    { path: config.socketDirectory, owner: "root", group: config.serviceAccount, mode: "0750" },
  ];
  for (const entry of ledger.slots) {
    if (entry.state !== "active") continue;
    const paths = personPaths(config, entry.slot);
    const user = accountName(entry.slot);
    plan.push({ path: paths.privateRoot, owner: user, group: user, mode: "0700" });
    plan.push({ path: paths.workspace, owner: user, group: config.peopleGroup, mode: "2770" });
  }
  return plan;
}

export function knownUnitNames(ledger) {
  return new Set([
    SLICE,
    ...ledger.slots.flatMap((entry) => [
      sliceName(entry.slot),
      socketName(entry.slot),
      serviceName(entry.slot),
    ]),
  ]);
}

export function renderTmpfiles(config) {
  return `d ${config.socketDirectory} 0750 root ${config.serviceAccount} -\n`;
}
