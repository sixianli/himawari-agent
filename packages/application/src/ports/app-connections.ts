export interface AppConnectionScope {
  readonly ownerId: string;
  readonly agentId: string;
}

export type AppConnectionStatus = "connected" | "needs_reconnect";

export interface AppConnectionRecord {
  readonly name: string;
  readonly tokensRef: string;
  readonly status: AppConnectionStatus;
  readonly connectedAt: string;
  readonly updatedAt: string;
}

export interface AddedAppRecord {
  readonly name: string;
  readonly title: string;
  readonly serverUrl: string;
  readonly createdAt: string;
}

export interface AppClientRecord {
  readonly name: string;
  readonly clientRef: string;
  readonly updatedAt: string;
}

export interface AppConnectionStorePort {
  read(
    input: AppConnectionScope & { readonly name: string },
  ): Promise<AppConnectionRecord | undefined>;
  list(input: AppConnectionScope): Promise<readonly AppConnectionRecord[]>;
  save(
    input: AppConnectionScope & {
      readonly name: string;
      readonly tokensRef: string;
      readonly status: AppConnectionStatus;
      readonly connectedAt: string;
      readonly now: string;
    },
  ): Promise<readonly string[]>;
  mark(
    input: AppConnectionScope & {
      readonly name: string;
      readonly status: AppConnectionStatus;
      readonly now: string;
    },
  ): Promise<void>;
  remove(input: AppConnectionScope & { readonly name: string }): Promise<readonly string[]>;
  listApps(input: AppConnectionScope): Promise<readonly AddedAppRecord[]>;
  addApp(
    input: AppConnectionScope & {
      readonly name: string;
      readonly title: string;
      readonly serverUrl: string;
      readonly now: string;
    },
  ): Promise<void>;
  removeApp(input: AppConnectionScope & { readonly name: string }): Promise<readonly string[]>;
  readClient(
    input: AppConnectionScope & { readonly name: string },
  ): Promise<AppClientRecord | undefined>;
  saveClient(
    input: AppConnectionScope & {
      readonly name: string;
      readonly clientRef: string;
      readonly now: string;
    },
  ): Promise<readonly string[]>;
}
