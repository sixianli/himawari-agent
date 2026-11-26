import {
  OWNER_SPOKEN_GATE,
  type ThresholdGate,
  thresholdFor,
  VOICE_AIRPODS_NEAR_GATE,
  VOICE_COMMAND_AMBIENT_GATE,
  VOICE_SCORE_MAX,
} from "@himawari-agent/calibration";

export const VOICE_TRIGGERS = ["airpods_name", "hands_on", "ambient_name"] as const;
export type VoiceTrigger = (typeof VOICE_TRIGGERS)[number];

export interface VoiceEvidence {
  readonly trigger: VoiceTrigger;
  readonly speakerScore: number | null;
  readonly inputRoute: "airpods" | "device_microphone" | "wearable_microphone" | null;
  readonly inEar: boolean | null;
  readonly loudnessScore: number | null;
  readonly heardName: string | null;
}

export const VOICE_HEARD_NAME_MAXIMUM_CHARACTERS = 64;

export const PHONE_VOICE_PROOF_PREFIX = "device-voice:";

export type VoiceCommandVerdict =
  | { readonly accepted: true; readonly reason: "hands_on" | "airpods_name" | "ambient_name" }
  | {
      readonly accepted: false;
      readonly reason:
        | "airpods_route_mismatch"
        | "airpods_not_in_ear"
        | "airpods_far"
        | "speaker_unconfirmed";
    };

export interface VoiceGates {
  readonly ambientCommand: ThresholdGate;
  readonly airpodsNear: ThresholdGate;
  readonly ownerSpoken: ThresholdGate;
}

export const DEFAULT_VOICE_GATES: VoiceGates = Object.freeze({
  ambientCommand: VOICE_COMMAND_AMBIENT_GATE,
  airpodsNear: VOICE_AIRPODS_NEAR_GATE,
  ownerSpoken: OWNER_SPOKEN_GATE,
});

export function isVoiceScore(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= VOICE_SCORE_MAX
  );
}

function passes(gate: ThresholdGate, score: number | null): boolean {
  return score !== null && score >= thresholdFor(gate, null);
}

export function decideVoiceCommand(
  evidence: VoiceEvidence,
  gates: VoiceGates = DEFAULT_VOICE_GATES,
): VoiceCommandVerdict {
  switch (evidence.trigger) {
    case "hands_on":
      return { accepted: true, reason: "hands_on" };
    case "airpods_name":
      if (evidence.inputRoute !== "airpods")
        return { accepted: false, reason: "airpods_route_mismatch" };
      if (evidence.inEar !== true) return { accepted: false, reason: "airpods_not_in_ear" };
      if (!passes(gates.airpodsNear, evidence.loudnessScore))
        return { accepted: false, reason: "airpods_far" };
      return { accepted: true, reason: "airpods_name" };
    case "ambient_name":
      return passes(gates.ambientCommand, evidence.speakerScore)
        ? { accepted: true, reason: "ambient_name" }
        : { accepted: false, reason: "speaker_unconfirmed" };
  }
}

export function isOwnerSpoken(
  speakerScore: number | null,
  gates: VoiceGates = DEFAULT_VOICE_GATES,
): boolean {
  return passes(gates.ownerSpoken, speakerScore);
}
