import { createCipheriv, randomInt } from "node:crypto";
import type {
  DataClassification,
  MemoryReminder,
  MemoryReminderStorePort,
  ProductMemoryRecord,
  ProductMemoryStatePort,
  RuntimeRequest,
} from "@himawari-agent/application";

const BARK_SERVER = "https://api.day.app";
const IV_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 6 * 3_600_000;
const BATCH = 10;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ReminderPushMessage {
  readonly title: string;
  readonly body: string;
  readonly dataClassification: DataClassification;
}

export interface ReminderPushChannel {
  send(message: ReminderPushMessage): Promise<void>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function randomIv(): string {
  return Array.from({ length: 16 }, () => IV_ALPHABET[randomInt(IV_ALPHABET.length)]).join("");
}

export function barkCiphertext(payload: string, key: string, iv: string): string {
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  return Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]).toString("base64");
}

function parseBarkSecret(secret: string): { deviceKey: string; encryptionKey: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error("REMINDER_PUSH_SECRET_INVALID");
  }
  const value = parsed as Record<string, unknown>;
  const deviceKey = value["deviceKey"];
  const encryptionKey = value["encryptionKey"];
  if (
    typeof deviceKey !== "string" ||
    !/^[A-Za-z0-9]{8,64}$/u.test(deviceKey) ||
    typeof encryptionKey !== "string" ||
    Buffer.byteLength(encryptionKey, "utf8") !== 32
  )
    throw new Error("REMINDER_PUSH_SECRET_INVALID");
  return { deviceKey, encryptionKey };
}

export function barkChannel(options: {
  readonly secret: () => Promise<string>;
  readonly server?: string;
  readonly fetch?: Fetch;
  readonly iv?: () => string;
}): ReminderPushChannel {
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    send: async (message) => {
      const { deviceKey, encryptionKey } = parseBarkSecret(await options.secret());
      const iv = (options.iv ?? randomIv)();
      const ciphertext = barkCiphertext(
        JSON.stringify({
          title: message.title,
          body: message.body,
          group: "Himawari",
          level: "timeSensitive",
        }),
        encryptionKey,
        iv,
      );
      const response = await send(`${options.server ?? BARK_SERVER}/${deviceKey}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ciphertext, iv }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => null)) as { code?: unknown } | null;
      if (!response.ok || result?.code !== 200)
        throw new Error(`REMINDER_PUSH_HTTP_${response.status}`);
    },
  };
}

export interface ProductionReminderPushOptions {
  readonly ownerId: RuntimeRequest["ownerId"];
  readonly agentId: RuntimeRequest["agentId"];
  readonly reminders: Pick<MemoryReminderStorePort, "listDue">;
  readonly state: Pick<ProductMemoryStatePort, "readMany">;
  readonly readText: (memory: ProductMemoryRecord) => Promise<string | undefined>;
  readonly channel: ReminderPushChannel;
  readonly now: () => string;
  readonly timeZone?: string;
  readonly intervalMs?: number;
  readonly onSent?: (reminder: MemoryReminder) => void;
  readonly onFailure: (error: unknown) => void;
}

export class ProductionReminderPush {
  readonly #options: ProductionReminderPushOptions;
  readonly #sent = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: ProductionReminderPushOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () => void this.tick(),
      this.#options.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.#timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  tick(): Promise<void> {
    this.#running ??= this.#push()
      .catch(this.#options.onFailure)
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #push(): Promise<void> {
    const { ownerId, agentId } = this.#options;
    const now = this.#options.now();
    const due = (
      await this.#options.reminders.listDue({ ownerId, agentId, now, limit: BATCH })
    ).filter(
      ({ id, remindAt }) =>
        !this.#sent.has(`${id}:${remindAt}`) &&
        Date.parse(now) - Date.parse(remindAt) <= STALE_AFTER_MS,
    );
    if (due.length === 0) return;
    const memories = new Map(
      (
        await this.#options.state.readMany({
          ownerId,
          agentId,
          memoryIds: due.map(({ memoryId }) => memoryId),
        })
      ).map((memory) => [memory.id, memory]),
    );
    const format = new Intl.DateTimeFormat("zh-CN", {
      timeZone: this.#options.timeZone ?? "UTC",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    for (const reminder of due) {
      const memory = memories.get(reminder.memoryId);
      if (!memory || memory.status !== "active") continue;
      const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
      if (!text) continue;
      try {
        await this.#options.channel.send({
          title: "Himawari 提醒",
          body: `${text}\n时间：${format.format(new Date(reminder.dueAt))}`,
          dataClassification: memory.dataClassification,
        });
        this.#sent.add(`${reminder.id}:${reminder.remindAt}`);
        this.#options.onSent?.(reminder);
      } catch (error) {
        this.#options.onFailure(error);
      }
    }
  }
}
