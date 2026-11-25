import type {
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
  VaultListedItem,
  VaultScope,
} from "@himawari-agent/application";
import { TOOL_VAULT_LIST } from "@himawari-agent/prompt-catalog";

export const VAULT_LIST_CAPABILITY_REF = "vault.list";
export const VAULT_CAPABILITY_REFS: readonly string[] = Object.freeze([VAULT_LIST_CAPABILITY_REF]);

export class VaultToolInputError extends Error {
  readonly code = "VAULT_TOOL_INPUT_INVALID";
  constructor() {
    super("VAULT_TOOL_INPUT_INVALID");
  }
}

export function vaultToolDescriptors(): readonly RuntimeToolDescriptor[] {
  return [
    {
      name: "vault_list",
      capabilityRef: VAULT_LIST_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_VAULT_LIST.text,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

export interface ProductionVaultToolsOptions {
  readonly scope: VaultScope;
  readonly list: (scope: VaultScope) => Promise<readonly VaultListedItem[]>;
}

export class ProductionVaultTools {
  readonly #options: ProductionVaultToolsOptions;

  constructor(options: ProductionVaultToolsOptions) {
    this.#options = options;
  }

  async run(invocation: RuntimeToolInvocation): Promise<unknown> {
    if (invocation.capabilityRef !== VAULT_LIST_CAPABILITY_REF) throw new VaultToolInputError();
    if (Object.keys(invocation.arguments).length !== 0) throw new VaultToolInputError();
    const items = await this.#options.list(this.#options.scope);
    return {
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        sites: item.sites,
      })),
    };
  }
}
