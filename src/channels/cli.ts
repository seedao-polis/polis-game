import readline from 'node:readline';
import type { Agent } from '../core/agent.js';
import type { Channel } from './channel.js';
import { log } from '../core/log.js';
import { dispatchCommand } from '../core/commands.js';

export interface CliChannelOptions {
  /** kimi session id prefix; lets the REPL carry short-term memory across turns (same conversation keeps memory). Omit it for stateless turns. */
  session?: string;
}

/** CLI channel: a local terminal REPL where you type directly to chat with the agent (like claude code / kimi code). */
export class CliChannel implements Channel {
  readonly name = 'cli';
  private readonly baseSession?: string;

  constructor(opts: CliChannelOptions = {}) {
    this.baseSession = opts.session;
  }

  run(agent: Agent): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // On /reset, switch to a new session suffix, which starts a new conversation and clears short-term memory.
    let resetCount = 0;
    const session = (): string | undefined =>
      this.baseSession ? `${this.baseSession}${resetCount ? `-r${resetCount}` : ''}` : undefined;

    log.info(`${agent.name} 已上线（CLI 频道）。`);
    console.log(
      [
        '  直接打字对话。指令：',
        '    /reset   开新对话（清掉本轮记忆）',
        '    /exit    结束',
        this.baseSession ? `  session：${session()}` : '  （无 session：每轮独立、无记忆）',
        '',
      ].join('\n')
    );

    const ask = (): void => {
      rl.question('你 > ', (line) => {
        const text = line.trim();
        if (text === '/exit' || text === '/quit') {
          rl.close();
          return;
        }
        if (text === '/reset') {
          resetCount += 1;
          log.info(`已开新对话（session：${session()}）`);
          ask();
          return;
        }
        if (!text) {
          ask();
          return;
        }
        // Try command mode first (pure code, no kimi call); only hand off to the agent if nothing matches.
        const dr = dispatchCommand(text, { agentName: agent.name, source: this.name });
        if (dr.handled) {
          process.stdout.write(`\n${agent.name} > ${dr.reply ?? ''}\n\n`);
          ask();
          return;
        }
        try {
          process.stdout.write('（思考中…）\n');
          const reply = agent.respond({ message: text, session: session() });
          process.stdout.write(`\n${agent.name} > ${reply}\n\n`);
        } catch (e) {
          log.error((e as Error).message);
        }
        ask();
      });
    };

    ask();
    return new Promise((resolve) => rl.on('close', resolve));
  }
}
