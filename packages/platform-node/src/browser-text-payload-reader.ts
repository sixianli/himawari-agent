import {
  ApplicationPortError,
  type GatewayAuthenticationContext,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import type { HttpGatewayPayloadReadPort } from "./http-gateway-server.js";

const IMAGE_PLAINTEXT_BYTES = 1_500_000;

export interface BrowserTextPayloadReaderOptions {
  readonly payloads: (ownerId: string, agentId: string) => PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly maximumPlaintextBytes?: number;
}

export class BrowserTextPayloadReader implements HttpGatewayPayloadReadPort {
  readonly #options: BrowserTextPayloadReaderOptions;

  constructor(options: BrowserTextPayloadReaderOptions) {
    this.#options = options;
  }

  async read(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly agentId: string;
    readonly payloadRef: string;
  }): Promise<{
    readonly content: string;
    readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
    readonly contentType: "text/plain" | "text/x-himawari-image";
  }> {
    const ownerId = createOwnerId(input.authentication.ownerId);
    const agentId = createAgentId(input.agentId);
    const payload = await this.#options.payloads(ownerId, agentId).get(input.payloadRef);
    const contentType = payload?.contentType;
    if (!payload || (contentType !== "text/plain" && contentType !== "text/x-himawari-image")) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Text Payload was not found");
    }
    const plaintext = await this.#options.protector.unprotect({ ownerId, agentId, payload });
    const limit =
      contentType === "text/x-himawari-image"
        ? IMAGE_PLAINTEXT_BYTES
        : (this.#options.maximumPlaintextBytes ?? 64 * 1024);
    if (plaintext.byteLength > limit) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Text Payload exceeds browser disclosure limit",
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Text Payload is not valid UTF-8",
      );
    }
    return Object.freeze({
      content,
      dataClassification: payload.dataClassification,
      contentType,
    });
  }
}
