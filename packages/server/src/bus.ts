import { EventEmitter } from "node:events";

/** Simple broadcast bus — server core publishes, transports subscribe. */
export class Bus extends EventEmitter {
  publish(channel: string | symbol, ...args: unknown[]): boolean {
    return this.emit(channel, ...args);
  }
}
