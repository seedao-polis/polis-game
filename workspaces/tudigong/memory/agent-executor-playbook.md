# 智能体执行器操作手册（城邦土地神工作区记忆）

> 我的"大脑"是**智能体执行器**（框架调用的本地推理 CLI）。改 `runKimi`、调执行器、或排查"回复失败"前，先读这份。
> 命令、参数、JSON 字段、ID 一律保留原文（它们是本机真实存在的路径与命令，维护时必须照实写）。

## 0. 最容易踩的坑（一句话版）

1. **旧版执行器的参数已废弃**：`--quiet` / `--agent-file` / `--mcp-config` / `--work-dir` 在当前执行器上会报 `unknown option`。当初"回复失败：error: unknown option '--quiet'"就是这个原因。
2. **`-p` 不能和 `--yolo` / `--auto` 一起用**（报 `Cannot combine --prompt with --yolo`）；但 `-p` 模式下工具会**自动执行**（无终端 = 自动批准），所以 MCP 工具照常能调。
3. **人格和工具靠项目本地配置文件，不靠命令行参数**：写到 `<工作目录>/.kimi-code/AGENTS.md`（人格）和 `<工作目录>/.kimi-code/mcp.json`（工具）。
4. **会话会"中毒"导致 `--continue` 永久 400**、自愈、串行回复 + 表情、错误日志/分类——全部独立成册：见 `memory/self-heal-playbook.md`。排"回复失败"先跑 `node dist/bin/agent.js doctor`。

## 1. 二进制与环境

- 程序：`~/.kimi-code/bin/kimi`，单文件原生程序（不是 `.cmd` 包装，没有中文/emoji 编码坑）。
- 配置：`~/.kimi-code/config.toml`（默认模型为执行器配置中指定的编程专用模型）；登录凭据在 `~/.kimi-code/credentials/`。
- 数据根目录可用 `KIMI_CODE_HOME` 覆盖，默认 `~/.kimi-code`。
- 框架里二进制解析在 `src/core/paths.ts` 的 `resolveKimiBin()`：认 `KIMI_BIN` → `KIMI_CODE_HOME`/`~/.kimi-code/bin` → PATH，跨 Windows/Linux/macOS。

## 2. 非交互（headless）调用要点

- 用执行器命令 `kimi -p "<提示词>"` 跑单轮、打印回复。
- 加 `--output-format stream-json`：输出是**逐行 JSON**，干净可解析：
  - `{"role":"assistant","content":"..."}` —— 最后一条带文字 content 的就是最终回复。
  - `{"role":"assistant","tool_calls":[...]}` —— 工具调用（没有文字 content，跳过）。
  - `{"role":"tool",...}` —— 工具结果。
  - `{"role":"meta","type":"session.resume_hint","session_id":"session_...",...}` —— 会话 id。
- **不要用纯文本输出**：会夹带思考（`•` 开头）和 `To resume this session:` 尾巴，难解析。
- 解析取"最后一条非空 assistant.content"即可（`src/core/kimi.ts` 的 `parseFinalMessage`）。按 `\r?\n` 切行，兼容 Windows。

## 3. 会话 / 短期记忆

- `-S <id>` / `--session <id>` **只能恢复已存在的会话**；传自定义 id 会报 `Session "<id>" not found`。
- 首次调用（不带 `-S`）自动生成 UUID 会话（`session_xxxx`），从 meta 行拿。
- `-C` / `--continue`：按**当前工作目录（cwd）**续接上一个会话；没有就"starting a fresh session"，不报错。⚠️ 它是**扫 `sessions/wd_<hash>/` 目录**认会话，不是只看 `session_index.jsonl`——所以隔离损坏会话只能把文件夹**移出 `sessions/`**，就地改名无效（详见 `memory/self-heal-playbook.md`）。
- 框架做法（`src/core/agent.ts`）：**每个聊天一个独立工作目录** `.agent/<soul>/chats/<会话键>`，有 session 就 `--continue` → 一个聊天 ↔ 一条会话血缘，互不串。无 session 的一次性调用用 `.agent/<soul>/work`，不续接。
- ⚠️ **续接的会话不会重新读 AGENTS.md**（人格在会话创建当下就定格进对话历史）。所以同一个长聊天里**新写入的长期记忆，要到下一个新会话才生效**。**Skill 同理**——`--continue` 也不会重扫 / 重读 skill，改 skill 要新会话才生效（框架已自动兜底，见 `agent-skill-playbook.md`）。
- ⚠️ **但 `mcp.json` 不在此列——它每轮都重读**（含 `--continue`），别把上面这条外推到工具宣告。**旧版本这里曾写成「缓存人格/MCP」，是错的**，已实测更正。详见 §4.1。

## 4. 人格 + 工具 = 项目本地配置文件

- 人格：`assembleSoul()`（`src/core/soul.ts`）把 IDENTITY/SOUL/AGENTS/... + 记忆拼成一段 markdown，写到 `<工作目录>/.kimi-code/AGENTS.md`，执行器当指令加载（实测能左右输出）。
- 工具：`buildMcpConfig()`（`src/core/agent.ts`）写 `<工作目录>/.kimi-code/mcp.json`，格式 `{"mcpServers":{"agent":{"command":<node>,"args":[mcp-server.js],"env":{...}}}}`（标准 MCP Server 格式）。用 `process.execPath` 当 node 路径，避开 Windows PATH 问题。
- 执行器找配置的优先级：用户级 `~/.kimi-code/` → 项目根（向上找最近的 `.git`）→ 项目本地 `<cwd>/.kimi-code/`。因为工作目录在仓库 `.agent/` 里（仓库根有 `.git`），所以**必须用项目本地 `<cwd>/.kimi-code/`** 才能按聊天隔离。

### 4.1 ⚠️ `AGENTS.md` 定格、`mcp.json` 每轮重读——两者不是一回事（实测定案）

**这是本册最容易误外推的一条。** `--continue` 只定格 `AGENTS.md`（人格），**`mcp.json`（工具宣告 + `env`）每轮都会重读、MCP server 子进程每轮重启**。

- **实测**：同一 workDir、第 2 轮带 `--continue`，两轮之间改写 `mcp.json` 的 `env.TEST_TURN_ID`：第 1 轮工具拿到 `turn-AAA-11111`，第 2 轮拿到**新值** `turn-BBB-22222`。执行器 **0.23.6**。
- **为什么两者不同**：`AGENTS.md` 的内容在会话创建时就写进**对话历史**，续接时模型读的是历史、不是文件；`mcp.json` 描述的是「这次进程要 spawn 哪些工具子进程、给什么 env」，属于**启动期行为**，每个新执行器进程都必须重做一次。`kimi.ts` 每轮都是全新 OS 进程（`runFileSync`/`runFileAsync`，无常驻 daemon），MCP 子进程随它共生共灭。
- **能这样用**：往 `mcp.json` 的 `env` 塞**每轮不同**的值，MCP 工具就能在当轮读到当轮的值（`AGENT_TURN_REF` 就是这么做的，见 [[pt-gamification-playbook]] §4.1）。`mcp-server.ts` 在**模块顶层**读 `process.env`——正因为每轮是新进程，顶层读取每轮重新求值。
- **边界**：这是外部 CLI 的**行为观察、不是契约保证**。升级执行器后若依赖 env 的功能出现异常（如 LP 尾注数字不对），**先重跑下面的探针复验**。
- **复验探针（可重跑）**：写一个最小 MCP stdio server（手搓 JSON-RPC 即可、不必依赖 MCP SDK，避开模块解析问题），只注册一个工具回传它**在进程启动时**从 env 读到的值——**必须在模块顶层读**，才和 `mcp-server.ts` 的失效模式一致。然后：写 `mcp.json`（env=A）→ 跑第 1 轮 → 改写 `mcp.json`（env=B）→ 带 `--continue` 跑第 2 轮 → 看第 2 轮拿到 A 还是 B。拿到 B＝每轮重读（假设成立）；拿到 A＝被定格（假设不成立）。**判读标准要在跑之前先定死**，别事后合理化。完整脚本与原始输出见 `thoughts/shared/research/2026-07-16-lp-net-change-per-turn.md` 附录 A。
- **两个探针踩坑**：① **macOS 没有 `timeout` 命令**（那是 GNU coreutils 的 `gtimeout`），脚本包了 `timeout 180` 会直接 `exit=127`，**看起来像执行器挂了、其实根本没跑到**；② 探针写到 stderr 的诊断**不会出现在执行器的 stderr**（`--output-format stream-json` 下执行器自己的 stderr 也是空的），所以拿不到 pid 佐证，只能靠回传值变化推——但回传值变化本身已是充分证据（值若被定格必然不变）。

## 5. node 运行环境

- 实际跑在 **Node 22.22.0**。Node 22 内建 `node:sqlite`（同步 `DatabaseSync`，FTS5/JSON1/WAL 都可用）——本地数据库选型用到，详见 `memory/local-db-playbook.md`。
