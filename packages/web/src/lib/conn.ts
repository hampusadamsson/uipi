import type { C2S, S2C } from "@uipi/protocol";

/**
 * Connection — WS client. Buffers outgoing messages until socket opens.
 * Callbacks: onMessage
 */
export class Conn {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending: C2S[] = [];
  private waiters = new Map<string, (m: S2C) => void>();

  onMessage: (m: S2C) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      for (const m of this.pending) this.send(m);
      this.pending = [];
      this.onOpen();
    };
    this.ws.onmessage = (ev) => {
      let msg: S2C & { id?: string };
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.id && this.waiters.has(msg.id)) {
        const w = this.waiters.get(msg.id)!;
        this.waiters.delete(msg.id);
        w(msg);
        return;
      }
      this.onMessage(msg);
    };
    this.ws.onclose = () => this.onClose();
  }

  private send(m: C2S): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else this.pending.push(m);
  }

  /** send and wait for reply carrying the correlation id */
  request<T extends S2C>(m: C2S, timeoutMs = 15000): Promise<T> {
    const id = `r${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("timeout waiting for reply"));
      }, timeoutMs);
      this.waiters.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg as T);
      });
      this.send({ ...m, id } as unknown as C2S);
    });
  }

  sendFire(m: C2S): void {
    this.send(m);
  }
}
