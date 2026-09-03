import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type HostFileDisclosurePort,
  type HostFilePlatformPort,
  type HostFileStatePort,
  type PayloadRef,
} from "../ports/index.js";
import type { ClockPort } from "../ports/system.js";
import { scanMachineSecrets } from "./machine-secret-exclusion.js";

export class HostFileReadService {
  readonly #state: HostFileStatePort;
  readonly #platform: HostFilePlatformPort;
  readonly #disclosure: HostFileDisclosurePort;
  readonly #clock: ClockPort;
  readonly #hostId: string;

  constructor(input: {
    readonly state: HostFileStatePort;
    readonly platform: HostFilePlatformPort;
    readonly disclosure: HostFileDisclosurePort;
    readonly clock: ClockPort;
    readonly hostId: string;
  }) {
    this.#state = input.state;
    this.#platform = input.platform;
    this.#disclosure = input.disclosure;
    this.#clock = input.clock;
    this.#hostId = input.hostId;
  }

  async readProtected(input: {
    readonly grantId: string;
    readonly relativePath: string;
    readonly destination: "model" | "worker" | "external_approved";
    readonly maximumBytes: number;
  }): Promise<PayloadRef> {
    const grant = await this.#state.readGrant(input.grantId);
    if (
      !grant ||
      grant.hostId !== this.#hostId ||
      grant.revokedAt ||
      grant.expiresAt <= this.#clock.now() ||
      !grant.operations.includes("read") ||
      grant.disclosure === "none" ||
      (input.destination === "external_approved" && grant.disclosure !== "external_approved") ||
      (input.destination === "worker" &&
        !["worker", "external_approved"].includes(grant.disclosure))
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Host file read is outside the approved directory and disclosure scope",
        { grantId: input.grantId },
      );
    }
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Host file read limit is invalid",
      );
    const bytes = await this.#platform.read(grant, input.relativePath, input.maximumBytes);
    const findings = scanMachineSecrets(new TextDecoder().decode(bytes));
    if (findings.length > 0)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Host file contains machine-secret material and cannot cross this disclosure boundary",
        { ruleIds: findings.map(({ ruleId }) => ruleId).join(",") },
      );
    return this.#disclosure.protect({
      grantId: grant.id,
      relativePath: input.relativePath,
      destination: input.destination,
      dataClassification: grant.dataClassification,
      bytes,
    });
  }
}
