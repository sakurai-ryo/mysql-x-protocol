import * as net from "node:net";
import * as tls from "node:tls";
import type { Buffer } from "node:buffer";

import { encodeFrame, type Frame, FrameBuffer } from "../protocol/framing.ts";

export interface ConnectOptions {
  host: string;
  port: number;
}

export interface TlsOptions extends tls.ConnectionOptions {}

type Resolver = { resolve: (frame: Frame) => void; reject: (err: Error) => void };

export class XSocket {
  private socket: net.Socket;
  private frameBuffer = new FrameBuffer();
  private pending: Frame[] = [];
  private waiters: Resolver[] = [];
  private fatal: Error | null = null;
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  static connect(opts: ConnectOptions): Promise<XSocket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: opts.host, port: opts.port });
      const onError = (err: Error) => {
        socket.removeAllListeners();
        reject(err);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        resolve(new XSocket(socket));
      });
    });
  }

  private attach(socket: net.Socket): void {
    socket.on("data", (chunk: Buffer) => {
      try {
        const frames = this.frameBuffer.push(chunk);
        for (const f of frames) this.deliver(f);
      } catch (err) {
        this.fail(err as Error);
      }
    });
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => {
      if (!this.closed) this.fail(new Error("connection closed by server"));
    });
  }

  private deliver(frame: Frame): void {
    const w = this.waiters.shift();
    if (w) w.resolve(frame);
    else this.pending.push(frame);
  }

  private fail(err: Error): void {
    if (this.fatal) return;
    this.fatal = err;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  send(type: number, payload: Uint8Array): void {
    if (this.fatal) throw this.fatal;
    if (this.closed) throw new Error("socket is closed");
    this.socket.write(encodeFrame(type, payload));
  }

  recv(): Promise<Frame> {
    if (this.fatal) return Promise.reject(this.fatal);
    const front = this.pending.shift();
    if (front) return Promise.resolve(front);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async startTls(options: TlsOptions = {}): Promise<void> {
    const underlying = this.socket;
    underlying.removeAllListeners("data");
    underlying.removeAllListeners("error");
    underlying.removeAllListeners("close");

    const tlsSocket = tls.connect({ ...options, socket: underlying });
    await new Promise<void>((resolve, reject) => {
      tlsSocket.once("secureConnect", resolve);
      tlsSocket.once("error", reject);
    });
    this.socket = tlsSocket;
    this.attach(tlsSocket);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.end();
    });
  }
}
