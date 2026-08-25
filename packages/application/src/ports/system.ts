export interface ClockPort {
  now(): string;
}

export interface IdGeneratorPort {
  next(namespace: string): string;
}
