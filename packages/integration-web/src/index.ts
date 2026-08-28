export * from "./public-web-adapter.js";
export * from "./untrusted-content.js";

export const integrationWebWorkspace = {
  adapterKind: "web-capability",
  protocolOwnership: "product-contracts-with-injected-platform-driver",
} as const;
