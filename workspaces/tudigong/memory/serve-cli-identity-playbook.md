# serve vs CLI 对话场景 / 对象判断 playbook

> 所有 agent 的通用约定（2026-06-25 建立）：**serve（飞书）里对面是外部对话者、即使是操作者本人也一视同仁；只有 CLI 里对面才是操作者。** 本文讲清这套约定的由来、框架机制、各 agent 怎么特化、改的时候要注意什么。

## 一、解决的问题（为什么有这条约定）

- 起因：profile-writer-yihan（人物志编辑 一涵）在飞书里收到操作者 Ricky 的私聊时，把他当成"同事 / 老板"来打招呼——"今天想访谈谁？要不要先核对素材？"。这是把【飞书里来对话的人】误当成了【操作者】。
- 本质：agent 的人格档默认写着"操作者是某某"，模型在 serve 对话里没有信号区分"现在对面到底是不是操作者"，就退回到人格档的默认叙事，把每个对话者（甚至随便一个居民）都当操作者来商量事情。
- 期望：**飞书（serve）里来跟 agent 说话的，一律是 agent 本职要服务 / 对待的那种人**（土地神→城邦居民、一涵→受访者）；**操作者身份只在 CLI 成立**。哪怕操作者本人在飞书里来对话，也要被一视同仁地当成普通对话者，而不是切回"运营/配置/商量下一步"的内部模式。

## 二、框架机制（信号怎么来的）

- `src/core/agent.ts` 的 `prepare()` 在**每条 prompt**（不是 system prompt）最前面注入一行【对话场景】：
  - `input.source === 'feishu-bot' || 'feishu-user'` → `【对话场景】serve 模式（飞书）：…对方是外部对话者，不是 CLI 操作者本人。`
  - 其余（CLI REPL `channels/cli.ts`、一次性 `agent ask` 都**不带 source**）→ `【对话场景】CLI 模式：当前对话者就是操作者本人。`
- **`prepare()` 每轮还会注入其它中性信号（2026-06-25 起；由各 soul 人格自行解读，不解读的无副作用）**：
  - `【对话轮次】这是第 N 轮`（仅 serve）：来自 channel 的 per-session 计数器，让 agent 自己掐节奏（如访谈每 3–4 轮主动播报进度）；内存计数、重启归零。
  - `【你的工作区目录】<绝对路径>`：让 agent 用文件工具读自己 workspace 下的 `examples/`、`memory/` 等源文件——**因为 agent 运行时 cwd 是 per-session 的 `.agent/<soul>/chats/<session>`、不是 workspace，相对路径（如 `examples/`）单独写解析不到，故注入绝对路径**。
  - `【当前对话者】姓名 / open_id`：让 agent 用对的 open_id 查 profile / LP / 徽章。
- 判定**只看 `source`，不看 open_id 是否等于操作者**。所以哪怕飞书来的是操作者本人，也归 serve、也当外部对话者——这正是"一视同仁"想要的。
- 信号是中立的：只说 serve/CLI + 对面是不是操作者，**不规定**该把对面当什么角色。"当成什么角色"由各 agent 的人格档自己解读，所以对不解读这条的旧 soul 完全无副作用。
- 代码改动落在 `dist/core/agent.js`（`pnpm build` 后）。**改 `agent.ts` 要重新构建并重启 serve worker 才生效**（运行中的 worker 跑的是旧编译代码）。

## 三、通用约定（写进了 _template，所有新 agent 自带）

样板 `workspaces/_template/` 的 SOUL / IDENTITY / USER / AGENTS / BOOT / memory/memories.md 都写死了 serve/CLI 段落，要点统一为：

- **serve 模式**：对面是外部对话者（角色由占位符 `{{SERVE_PARTY_ROLE}}` 指定），即使是操作者本人也一视同仁、当普通对话者，不谈配置 / 运营 / 内部指令。
- **CLI 模式**：对面才是操作者本人，才接受运营、配置、方向设定等内部对话。
- 新 agent 唯一要填的是 `{{SERVE_PARTY_ROLE}}`（如「城邦居民」「受访者」「求助者」）——serve/CLI 的判断逻辑是固定文字、不用每个 agent 重写。

create-agent skill 已配套更新：`SKILL.md` 第 4 条 essential_principle、`references/placeholders.md`（新占位符 + 第 9 节共享表）、`templates/agent-spec.md`（serve 对话者角色字段）、`workflows/gather-requirements.md`（必问项）、`workflows/copy-and-customize.md`（各文件替换清单加 `{{SERVE_PARTY_ROLE}}`）、`references/agent-anatomy.md`（机制说明）。

## 四、各 agent 的特化（同一约定、不同角色）

| agent | serve 里对面是 | 特别说明 |
|-------|---------------|---------|
| `tudigong`（城邦土地神） | 城邦居民 | 本就"面向整个城邦不偏待一人"，serve 里操作者也当普通居民照看 |
| `profile-writer-yihan`（一涵） | 受访者（访谈对象） | 额外有"新访谈 vs 续访谈"开场规则：先看【背景记忆】/`memory_search`，**无**这人跨群同人访谈记忆→当新访谈、自我介绍+暖场后直接开始访谈（别问"想访谈谁"）；**有**→续访谈、自然提一句近期记忆再接上次线索。跨群同人以 open_id 为准（`user:` 记忆本就跨群通用） |

## 五、改的时候要注意（how to apply / 坑）

- **人格档改了什么时候生效**：`prepare()` 每次都会重写 `.kimi-code/AGENTS.md`，但执行器 `--continue` 在**会话创建当下**就把 AGENTS.md 定格、续接不重读（与 skill 缓存同理，见 `agent-skill-playbook.md`）。所以人格档（SOUL/USER/…）改动**只对新会话生效**，已有的 per-(chat,user) 会话要重启 / 隔离后才套用。
  - ⚠️ **这条只管 `AGENTS.md`（人格 / 系统提示词），别外推到 `mcp.json`（工具宣告 + `env`）**——`mcp.json` **每轮都重读**、MCP server 子进程每轮重启，实测定案（见 [[agent-executor-playbook]] §4.1）。两者性质不同：人格在会话创建时写进对话历史，工具宣告则是每个新进程的启动期行为。**曾经差点因为把这条外推到 `mcp.json`，而放弃「往 env 塞每轮 ref」这条正确路线**（[[pt-gamification-playbook]] §4.1）。
- **`agent.ts` 改了**：必须 `pnpm build` + 重启对应 serve worker（热重启 `pnpm agent update` 需要 serve 带 `--sup`；没带 `--sup` 的 worker 要手动停了重起）。
- **不要用 open_id 去特判操作者**：判断 serve/CLI 只认 `source`。想"操作者在飞书里也走内部模式"是反需求——本约定就是要避免它。
- **新增 channel 要归类**：以后若加新的对外 channel，记得在 `prepare()` 的 `isServe` 判断里把它算进 serve，否则会被误当 CLI（当成操作者）。
