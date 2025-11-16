declare module "undici" {
  interface AgentOptions {
    bodyTimeout?: number;
    headersTimeout?: number;
  }

  class Agent {
    constructor(options?: AgentOptions);
    dispatch(...args: unknown[]): unknown;
    close(): Promise<void>;
  }

  export { Agent, AgentOptions };
}

import type { Agent as UndiciAgent } from "undici";

declare global {
  interface RequestInit {
    // Allow undici dispatcher configuration for Node streaming fetch
    dispatcher?: UndiciAgent;
  }
}

export {};
