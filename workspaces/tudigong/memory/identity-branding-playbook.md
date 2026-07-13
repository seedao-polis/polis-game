# 身份 / 品牌标识 playbook（persona emoji · 视觉标识改动）

> 怎样改城邦土地神（或任何 soul）的**视觉标识**——最典型是【代表 emoji】——并让它在飞书里真正生效。核心是先分清【标识在哪几处、哪处是源头、哪处是编译产物、哪处是历史副本】，再走对构建 / 重启链路。

## §1 persona emoji 的三层来源（改前先分清）

一个 soul 的代表 emoji 会出现在三类地方，改法与生效方式完全不同：

1. **人格档源头（LLM 自发使用）** —— `workspaces/<soul>/IDENTITY.md` 里 `- **emoji**：🪐`。
   - 这是【唯一源头】：LLM 生成的所有飞书消息（迎新语、Meetup 播报、群里回复……）开头那个 emoji，都是模型**照人格档自选**的，不是模板拼的。**grep 源码找不到那些消息里的 emoji，正因为它们是 LLM 现写的。**
   - IDENTITY.md 属【大写人格档】，改它 → `reloadSoulIfChanged` 按内容指纹在下次 `serve` 重启 / `agent update` 时**隔离该 soul 全部会话**，新会话载入新 emoji 后 LLM 才改口（见 `agent-skill-playbook.md §5`）。
   - `SOUL.md` 描述人设（土地神＝中国民间土地公），**不含 emoji**、改 emoji 不必动它。

2. **框架确定性模板（硬编码，LLM 不经手）** —— 改 IDENTITY.md **管不到**，必须逐处改源码 / 配置：
   - `src/core/events.ts` —— 事件标题 / 正文模板（硬编码 persona 串，逐个事件改），如 `lurker-discovered` 的 `title: '🐟 {{lurker_name}} 在社区潜水被发现了'`。（原带 🪐 的 `welcome-party` 标题已于 2026-07-13 随该事件删除。）
   - `configs/agents.json` + `configs/agents.json.example` —— `replyPrefix`（`🪐 城邦土地神：`；注意 **bot 频道已不加前缀、只 user 频道生效**，见 `memories.md` 开发规范节）。
   - 改源码后 serve 要**重建 dist + 重启**（见 §3）。

3. **会话历史副本（可改可不改、纯历史）** —— `.agent/<soul>/chats/*/.kimi-code/AGENTS.md`。
   - 这是每个会话创建时**从 `workspaces/<soul>` 组装出来的人格快照**，属运行时状态、新会话会重新生成。里头的 emoji 只影响**已存在的旧会话**，对未来输出无约束力（未来由 IDENTITY.md 管）。
   - 批量改它们纯为历史一致 / 观感，非必需。

## §2 一次典型改动的落点清单（2026-07-08：🏯→🪐）

运营者要求把代表 emoji 从 🏯（城堡）换成 🪐（环状行星），因为 **SeeDAO logo 是木星（Jupiter）**。全部落点：
- `workspaces/tudigong/IDENTITY.md`（源头，驱动全部 LLM 输出）
- `src/core/events.ts`（当时改的是 `welcome-party` 标题模板；该事件已于 2026-07-13 删除，未来 emoji 改动看其余事件标题）
- `configs/agents.json` + `.example`（`replyPrefix`）
- `workspaces/tudigong/memory/memories.md`（文档里引用 prefix 的两处，随手对齐）
- `.agent/**/.kimi-code/AGENTS.md`（15 个会话历史副本，为一致性一起换）
- **故意不动**：`thoughts/**`（历史研究 / 施工记录）、`workspaces/_shared/skills/create-agent/references/placeholders.md`（那是给**别的** agent 用的 `{{AGENT_EMOJI}}` 通用示例，改了会误导新 agent 默认成 🪐）。

小知识：🪐 是 Unicode「ringed planet」（视觉上是土星），但它是**唯一的行星 emoji**，运营者认可用它代表木星——这是【品牌决定】不是技术约束。

## §3 构建 / 部署链路（改源码后怎么生效）

- **serve 跑编译产物**：`pnpm agent serve` ＝ `node dist/bin/agent.js serve`，读的是 `dist/`。改了 `src/` 必须先 `pnpm build`（＝ `tsc -p tsconfig.build.json`）重建 dist，否则 serve **完全看不到**新代码；改完可 grep `dist/core/events.js` 确认。
- **CLI / dev 跑源码**：`pnpm dev` ＝ `tsx src/bin/agent.ts` 直接吃 `src/`，改完即时生效、无需重建。
- **改 config / 人格档要重启 serve**：`configs/agents.json`、`IDENTITY.md` 这类不是热重载的；serve 要**完整重启**（人格档还会触发 `reloadSoulIfChanged` 隔离会话）。同 memory 里那条「改 DB migration / 核心档要完整重启 serve」。

## §4 环境坑：rtk hook 会改写 git / npm / grep

本机全局挂了 rtk（token 优化代理），会**改写** `git`/`npm`/`grep` 等命令，批量改动 / 校验时踩过两坑：
- **`npm run build` 被改坏**：报 `npm error Missing script: "run"`。绕开——直接 `npx tsc -p tsconfig.build.json`（或 `node_modules/.bin/tsc …`）。
- **rtk 的 grep 代理破坏 NUL 输出、还会误报**：`grep -rlZ … | xargs -0` 管线里 `-Z`/`-l` 的 NUL 分隔被打乱、文件名黏成一坨报 `File name too long`；更坑的是 `grep -rln "🏯"` 明明还在却回 `none`（**假阴性**），差点误判「已改完」。
- **批量查找 / 替换 / Unicode 校验一律绕开 grep 代理，改用 `find … -exec perl`**：
  ```
  find . -name AGENTS.md -not -path '*/node_modules/*' -not -path '*/thoughts/*' \
    -exec perl -CSD -i -pe 's/\x{1F3EF}/\x{1FA90}/g' {} +
  ```
  校验也用 perl（别再信 rtk grep 的计数）：`\x{1F3EF}`＝🏯（城堡）、`\x{1FA90}`＝🪐（环状行星）；`-CSD` 让 perl 按 UTF-8 读写。

## §5 通用教训

- **改 agent 视觉标识，先分清「LLM 自选」还是「框架硬编码」**：前者只改 IDENTITY.md 源头，后者要逐处改源码 + 重建。别以为 grep 不到就没有——LLM 现写的 emoji 天然 grep 不到。
- **serve 看 dist、改 src 必重建**；改配置 / 人格档必重启 serve（同「核心档要完整重启」）。
- **本机工具被 rtk 改写**，批量 / Unicode 操作用 `find -exec perl`、别信 rtk grep 的计数。
