import { PI_COMPUTER_WORKSPACE } from "@himawari-agent/execution-contracts";

export interface UserComputerExecInput {
  readonly ownerId: string;
  readonly argv: readonly string[];
  readonly stdin?: Uint8Array;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly allowedDomains: readonly string[];
  readonly deadlineAt: string;
  readonly maxOutputBytes: number;
  readonly runtime?: string;
}

export interface UserComputerExecResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly truncated: boolean;
}

export interface UserComputerStatus {
  readonly ownerKey: string;
  readonly state: "running" | "stopped";
  readonly activeCalls: number;
  readonly lastActivityAt: string | null;
  readonly lastStartedAt: string | null;
  readonly memoryBytes: number | null;
}

export interface UserComputers {
  exec(input: UserComputerExecInput): Promise<UserComputerExecResult>;
}

export interface UserComputerSeedInput {
  readonly ownerId: string;
  readonly source: string;
}

export interface UserComputerSeedResult {
  readonly copied: boolean;
  readonly seededFrom: string | null;
  readonly seededAt: string | null;
}

export interface UserComputerWorkspaces {
  seedWorkspace(input: UserComputerSeedInput): Promise<UserComputerSeedResult>;
}

export const USER_COMPUTER_ERROR_CODES = [
  "COMPUTER_START_FAILED",
  "COMPUTER_WAITING_FOR_MEMORY",
  "COMPUTER_UNAVAILABLE",
  "COMPUTER_DEADLINE_PASSED",
  "COMPUTER_REQUEST_INVALID",
  "COMPUTER_SEED_FAILED",
] as const;

export type UserComputerErrorCode = (typeof USER_COMPUTER_ERROR_CODES)[number];

export class UserComputerError extends Error {
  readonly code: UserComputerErrorCode;
  readonly detail: string;

  constructor(code: UserComputerErrorCode, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "UserComputerError";
    this.code = code;
    this.detail = detail;
  }
}

export const COMPUTER_HOME = "/home/himawari";
export const COMPUTER_WORKSPACE = PI_COMPUTER_WORKSPACE;
export const COMPUTER_RUNTIME = "/opt/himawari";
