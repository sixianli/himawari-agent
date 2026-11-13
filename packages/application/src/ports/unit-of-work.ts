export interface UnitOfWorkPort {
  run<TResult>(work: () => Promise<TResult>): Promise<TResult>;
}
