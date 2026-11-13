import type { Socket } from "node:net";

export const JOB_HOST_GATEWAY_FRAME_MAX_BYTES = 64 * 1024 * 1024;

export function writeGatewayFrame(
  socket: Socket,
  frame: Record<string, unknown>,
  onFailure?: () => void,
): void {
  if (socket.destroyed || !socket.writable) {
    onFailure?.();
    return;
  }
  socket.write(`${JSON.stringify(frame)}\n`, (error) => {
    if (error) onFailure?.();
  });
}

export function readGatewayFrames(
  socket: Socket,
  onFrame: (frame: Record<string, unknown>) => void,
  onInvalid: () => void,
): void {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let invalid = false;
  socket.on("data", (chunk: Buffer) => {
    if (invalid) return;
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      if (pendingBytes + index - start > JOB_HOST_GATEWAY_FRAME_MAX_BYTES) {
        invalid = true;
        onInvalid();
        return;
      }
      pending.push(chunk.subarray(start, index));
      const line = Buffer.concat(pending).toString("utf8");
      pending = [];
      pendingBytes = 0;
      start = index + 1;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        frame = null;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        invalid = true;
        onInvalid();
        return;
      }
      onFrame(frame as Record<string, unknown>);
      if (invalid || socket.destroyed) return;
    }
    const rest = chunk.subarray(start);
    pendingBytes += rest.length;
    if (pendingBytes > JOB_HOST_GATEWAY_FRAME_MAX_BYTES) {
      invalid = true;
      onInvalid();
      return;
    }
    if (rest.length) pending.push(rest);
  });
}
