import type { Channel } from './channel.js';
import type { ResolvedAgent, Identity } from '../core/configs.js';
import { CliChannel } from './cli.js';
import { FeishuUserChannel } from './feishu-user.js';
import { FeishuBotChannel } from './feishu-bot.js';

// ── Channel registry ─────────────────────────────────────────────
// serve picks the matching channel by identity (user→FeishuUserChannel, bot→FeishuBotChannel);
// local testing picks by channel name (cli→CliChannel). New platforms can be added following this pattern.

/** Create the matching Feishu channel by identity (requires the resolved agent config). */
export function channelForIdentity(identity: Identity, cfg: ResolvedAgent): Channel {
  switch (identity) {
    case 'user':
      return new FeishuUserChannel(cfg);
    case 'bot':
      return new FeishuBotChannel(cfg);
    default:
      throw new Error(`未知身份【${identity}】`);
  }
}

/** Create a channel by channel name (currently supports the local cli; for Feishu use channelForIdentity). */
export function channelByName(name: string): Channel {
  switch (name) {
    case 'cli':
      return new CliChannel();
    default:
      throw new Error(`未知频道【${name}】（本地测试仅支持 cli）`);
  }
}
