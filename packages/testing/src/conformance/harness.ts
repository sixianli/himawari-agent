export type Awaitable<TValue> = Promise<TValue> | TValue;

export interface PortConformanceHarness<TPort> {
  create(): Awaitable<TPort>;
  dispose?(port: TPort): Awaitable<void>;
}

export interface ConfiguredPortConformanceHarness<TPort, TConfiguration> {
  create(configuration: TConfiguration): Awaitable<TPort>;
  dispose?(port: TPort): Awaitable<void>;
}

export async function withPort<TPort, TResult>(
  harness: PortConformanceHarness<TPort>,
  assertion: (port: TPort) => Awaitable<TResult>,
): Promise<TResult> {
  const port = await harness.create();
  try {
    return await assertion(port);
  } finally {
    await harness.dispose?.(port);
  }
}

export async function withConfiguredPort<TPort, TConfiguration, TResult>(
  harness: ConfiguredPortConformanceHarness<TPort, TConfiguration>,
  configuration: TConfiguration,
  assertion: (port: TPort) => Awaitable<TResult>,
): Promise<TResult> {
  const port = await harness.create(configuration);
  try {
    return await assertion(port);
  } finally {
    await harness.dispose?.(port);
  }
}
