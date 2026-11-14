import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  JOB_HOST_GATEWAY_FRAME_MAX_BYTES,
  readGatewayFrames,
} from "../src/job-host-gateway-frames.ts";

function read(chunks: readonly Buffer[]) {
  const socket = new EventEmitter();
  const frames: unknown[] = [];
  const invalid = vi.fn();
  readGatewayFrames(socket as unknown as Socket, (frame) => frames.push(frame), invalid);
  for (const chunk of chunks) socket.emit("data", chunk);
  return { frames, invalid };
}

describe("gateway frames", () => {
  it("joins a frame split across chunks and splits frames sharing a chunk", () => {
    const { frames, invalid } = read([
      Buffer.from('{"type":"a"}\n{"ty'),
      Buffer.from('pe":"b"}\n'),
    ]);
    expect(frames).toEqual([{ type: "a" }, { type: "b" }]);
    expect(invalid).not.toHaveBeenCalled();
  });

  it("rejects a complete line longer than the limit even when it arrives in one chunk", () => {
    const line = `{"type":"${"x".repeat(JOB_HOST_GATEWAY_FRAME_MAX_BYTES)}"}\n`;
    const { frames, invalid } = read([Buffer.from(line)]);
    expect(frames).toEqual([]);
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("rejects an unterminated line once it grows past the limit", () => {
    const { invalid } = read([Buffer.alloc(JOB_HOST_GATEWAY_FRAME_MAX_BYTES + 1, 0x20)]);
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("stops reading after a line that is not a JSON object", () => {
    const { frames, invalid } = read([Buffer.from('[1]\n{"type":"a"}\n')]);
    expect(frames).toEqual([]);
    expect(invalid).toHaveBeenCalledTimes(1);
  });
});
