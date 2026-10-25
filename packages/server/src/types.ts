import type { S2C } from "@uipi/protocol";

/**
 * SessionService wraps one pi AgentSession + its WS subscribers.
 * Server owns sessions; they live while the browser is closed.
 */

export type Send = (msg: S2C) => void;

export interface Subscriber {
  send: Send;
}
