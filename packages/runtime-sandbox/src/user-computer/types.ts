export interface UserComputerExecInput {
  readonly ownerId: string;
  readonly argv: readonly string[];
  readonly stdin?: Uint8Array;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly allowedDomains: readonly string[];
  readonly deadlineAt: string;
  readonly maxOutputBytes: number;
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

export const USER_COMPUTER_ERROR_CODES = [
  "COMPUTER_START_FAILED",
  "COMPUTER_WAITING_FOR_MEMORY",
  "COMPUTER_UNAVAILABLE",
  "COMPUTER_DEADLINE_PASSED",
  "COMPUTER_REQUEST_INVALID",
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
