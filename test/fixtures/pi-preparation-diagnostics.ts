import { afterAll, afterEach, beforeEach } from "vitest";

const moduleUrl = new URL("./pi-preparation-diagnostics.mjs", import.meta.url).href;
type DiagnosticModule = {
  beginPiPreparationDiagnostics(context: { testName: string; testId: string; file: string }): void;
  flushPiPreparationDiagnostics(): void;
  piPreparationDiagnosticArguments(): string[];
};

const diagnostics: DiagnosticModule = await import(moduleUrl);

export function trackPiPreparationDiagnostics(file: string) {
  if (!process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"]) return;
  beforeEach((context) => {
    diagnostics.beginPiPreparationDiagnostics({
      file,
      testName: context.task.name,
      testId: context.task.id,
    });
  });
  afterEach(() => diagnostics.flushPiPreparationDiagnostics());
  afterAll(() => diagnostics.flushPiPreparationDiagnostics());
}

export const piPreparationDiagnosticArguments = diagnostics.piPreparationDiagnosticArguments;
