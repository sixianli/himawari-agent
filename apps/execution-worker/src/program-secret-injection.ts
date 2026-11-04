export interface ProgramSecretSource {
  resolve(secretRef: string, secretVersion: string): Promise<string>;
}

export async function injectProgramSecrets(input: {
  readonly stored: Uint8Array;
  readonly granted: readonly { readonly secretRef: string; readonly secretVersion: string }[];
  readonly networkOnly: boolean;
  readonly secrets?: ProgramSecretSource;
}): Promise<Uint8Array> {
  if (!input.secrets || !input.networkOnly) throw new Error("SANDBOX_SECRET_UNSUPPORTED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.stored));
  } catch {
    throw new Error("SANDBOX_SECRET_INPUT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("SANDBOX_SECRET_INPUT_INVALID");
  const { secretRefs: names, ...rest } = parsed as { [key: string]: unknown };
  if ("secrets" in rest || !names || typeof names !== "object" || Array.isArray(names))
    throw new Error("SANDBOX_SECRET_INPUT_INVALID");
  const mapped = Object.entries(names as { [key: string]: unknown });
  if (
    mapped.length !== input.granted.length ||
    new Set(mapped.map(([, ref]) => ref)).size !== mapped.length ||
    mapped.some(
      ([name, ref]) =>
        !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
        !input.granted.some(({ secretRef }) => secretRef === ref),
    )
  )
    throw new Error("SANDBOX_SECRET_INPUT_INVALID");
  const values: { [key: string]: string } = {};
  for (const [name, ref] of mapped) {
    const secret = input.granted.find(({ secretRef }) => secretRef === ref);
    if (!secret) throw new Error("SANDBOX_SECRET_INPUT_INVALID");
    try {
      values[name] = await input.secrets.resolve(secret.secretRef, secret.secretVersion);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      console.error(
        JSON.stringify({
          event: "sandbox.secret.unavailable",
          name,
          secretRef: secret.secretRef,
          secretVersion: secret.secretVersion,
          errorCode: /^E[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN",
        }),
      );
    }
  }
  return Buffer.from(JSON.stringify({ ...rest, secrets: values }));
}
