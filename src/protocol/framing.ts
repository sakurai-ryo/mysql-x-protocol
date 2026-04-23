import { Buffer } from "node:buffer";

export type Frame = { type: number; payload: Buffer };

const HEADER_SIZE = 5;

export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  out.writeUInt32LE(payload.length + 1, 0);
  out.writeUInt8(type, 4);
  out.set(payload, HEADER_SIZE);
  return out;
}

export class FrameBuffer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    while (this.buf.length >= HEADER_SIZE) {
      const length = this.buf.readUInt32LE(0);
      if (length < 1) {
        throw new Error(`invalid X Protocol frame length: ${length}`);
      }
      const total = 4 + length;
      if (this.buf.length < total) break;
      const type = this.buf[4]!;
      const payload = this.buf.subarray(HEADER_SIZE, total);
      frames.push({ type, payload });
      this.buf = this.buf.subarray(total);
    }
    return frames;
  }
}
