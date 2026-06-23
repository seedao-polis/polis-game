import type { Agent } from '../core/agent.js';

/** Channel: connects an external message source to the agent. run() runs until it finishes. */
export interface Channel {
  readonly name: string;
  run(agent: Agent): Promise<void>;
}
