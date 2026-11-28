import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const apple = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../clients/apple");
const models = path.join(apple, "Sources/HimawariListenEngine/SpeakerModels");
const pinned = {
  "pyannote_segmentation.mlmodelc/weights/weight.bin":
    "0266f4ad4d843ecf31ef9220ad6b80616b3ec64a4404b64f3ea0371554e236ec",
  "wespeaker_v2.mlmodelc/weights/weight.bin":
    "34004f6798d35cad7071e2fdc67e63faaa782f53697e1cb49bcb452cf81ae151",
};

function swiftFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return swiftFiles(full);
    return name.endsWith(".swift") ? [full] : [];
  });
}

export function modelDownloadCalls(source) {
  return [
    ...source.matchAll(/\b(?:downloadIfNeeded|ModelHub\.\w+|DiarizerModels\.download)\s*\(/gu),
  ].map((match) => match[0]);
}

it("[I-261129-030c] the voiceprint models ship inside the app with the pinned weights", () => {
  for (const [file, sha256] of Object.entries(pinned)) {
    const digest = createHash("sha256")
      .update(readFileSync(path.join(models, file)))
      .digest("hex");
    expect(digest, file).toBe(sha256);
  }
  for (const bundle of ["pyannote_segmentation.mlmodelc", "wespeaker_v2.mlmodelc"]) {
    for (const part of ["coremldata.bin", "model.mil", "metadata.json"]) {
      expect(statSync(path.join(models, bundle, part)).size, `${bundle}/${part}`).toBeGreaterThan(
        0,
      );
    }
  }
  expect(readFileSync(path.join(models, "NOTICE.txt"), "utf8")).toMatch(/CC-BY-4\.0/u);
  expect(readFileSync(path.join(apple, "Package.swift"), "utf8")).toContain(
    '.copy("SpeakerModels")',
  );
});

it("[I-261129-030c] no app code downloads a speech model while the owner waits", () => {
  const offenders = swiftFiles(path.join(apple, "Sources")).flatMap((file) =>
    modelDownloadCalls(readFileSync(file, "utf8")).map(
      (call) => `${path.relative(apple, file)}: ${call}`,
    ),
  );
  expect(offenders).toEqual([]);
});

it("[I-261129-030c] the old embedder that downloaded models at enrollment is caught", () => {
  expect(
    modelDownloadCalls("        let models = try await DiarizerModels.downloadIfNeeded()\n"),
  ).toEqual(["downloadIfNeeded("]);
});
