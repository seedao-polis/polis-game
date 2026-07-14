# 行情查询 skill（market-price-lookup）Playbook

> tudigong **专属** skill：按名称 / 代码查**东方财富能查到的任意标的**（A股 / 港股 / 美股 / ETF / 基金 / 全球指数 / 板块 / 债券…）的即时报价与日 / 周 / 月 K 线。2026-07-14 上线。skill 目录 `workspaces/tudigong/skills/market-price-lookup/`；三模式 `resolve` / `quote` / `kline`；数据走东财网页接口、**免密钥、无第三方依赖**（Node 内建 fetch）；自带**跨进程本地限流器**避免撞东财 IP 风控。动这个 skill 前先读本篇。
>
> 研究 / 评估全记录：`thoughts/shared/research/2026-07-14-tudigong-finance-datasource-skill-evaluation.md`。

## 0. 最容易踩的坑（一句话版）

1. **KRXSEM（韩国半导体指数）四个免费源全查不到**：FinanceDatabase、yfinance、东财、TradingAgents-astock 都没有这支细分指数，只有 Investing.com / HKEX 有。遇到「韩国半导体指数」只能**降级答 KOSPI（`100.KS11`）或引导 Investing.com、绝不拿 KOSDAQ 半导体等相近标的冒充、绝不臆测数字**。
2. **每次调 skill 是独立 `node` 进程**，进程内节流管不到并发调用 → 必须用**机器级跨进程限流器**（`scripts/rate-limiter.mjs`：状态落 tmpdir、lockdir 抢锁预约错开时段）。这是本次核心交付。
3. **别手拼 secid、优先 `resolve`**：同名 / 同代码跨市场撞车（`KS11` 搜出来第一条是债券、第二条才是指数；`00700` 同时命中港股腾讯 + 深A + 韩股）。裸名字查询脚本只取第一条，回传带 `resolved` / `alternatives`，**务必核对 `resolved.name` 对不对**。
4. **东财 push2 / push2his 限流会「连不上」不是报错码**（`UND_ERR_SOCKET` / `operation was aborted`）——高频撞 IP 风控就这样。脚本已 graceful degradation（回结构化 `{ok:false}`），如实告知「行情源暂时不可用、稍后再试」别编数字。
5. **这个 skill 不碰 TC 结算**：`computeTcSettlement()` 不吃外部真值（结算＝投注者猜测的加权平均、社区共识）。finance skill 只做信息性回答 / 佐证，改不了 TC 输赢判定。
6. **放 tudigong 专属层不放共用层**：脚本核心是具名东财 URL，跟共用 skill「移除外部产品代号」的中立化房规冲突，专属层规避。

## 1. 需求由来（KRXSEM → KS11 的转向）

- 背景：社区围绕金融市场讨论（TP-4 是我们自己发起的一个 Temperature Check「明天韩国半导体产业指数还会跌吗」）。土地神需要真实行情来回答提问、给 TC 当客观背景。
- 使用者原想查 **KRX Semiconductor（KRXSEM，韩国半导体指数）**。实测四个源全查不到（见 §2）。
- 转向 **KS11（KOSPI 韩国综合指数）**，资料源用东方财富国际指数（页面 `quote.eastmoney.com/gb/zsKS11.html`），实测即时 + 历史都通 → 定为 skill 主干。

## 2. KRXSEM 四源实测对照（诚实边界，别重复踩）

| 源 | 能查 KRXSEM？ | 能查 KOSPI？ | 性质 |
|----|-------------|-------------|------|
| FinanceDatabase (JerBouma v2.4.0) | ❌ 未收录（最近只有 KOSDAQ 半导体 `^KQ47`） | 只有 symbol、**无行情** | 91,181 条指数中继资料目录、离线免 key |
| yfinance 免费端点 | ❌ `KRXSECTOR-2.KS` / `^KQ47` 抓不到行情 | ✅ `^KS11` | 大盘 OK、韩国半导体子指数不行 |
| TradingAgents-astock (simonlin1212) | ❌ 全库 KRX=0 | ❌ 本身不抓国际指数 | A 股专用 LangGraph 框架、只做中国 A 股；可复用的是它 `a_stock.py` 的东财防封 `_em_get` 思路 |
| 东方财富 | ❌ resolve 搜 KRX / 韩国半导体=0 | ✅ `secid=100.KS11` | 网页接口、免 key、无依赖 |

**结论：专门的 KRX 半导体指数只有 Investing.com（`cn.investing.com/indices/krx-semiconductor`）/ HKEX 有。**

## 3. 东财接口（三模式，实测确立）

secid = `<市场前缀>.<代码>`。**前缀不用背，`resolve` 直接给完整 secid（`QuoteID`）。**

- **resolve（名字 / 代码 → secid）**：`searchapi.eastmoney.com/api/suggest/get?input=<kw>&type=14&token=<公开前端token>&count=<n>` → `QuotationCodeTable.Data[]`，每条取 `QuoteID`(secid) / `Code` / `Name` / `SecurityTypeName`。token `D43BF722C8E33BDC906FB84D85E326E8` 是东财网页写死的**公开值、非密钥**。
- **quote（即时）**：`push2.eastmoney.com/api/qt/stock/get?invt=2&fltt=2&secid=<secid>&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170`。`fltt=2&invt=2` 时价格直接是真实值免 /100。f43=最新 f46=今开 f44=最高 f45=最低 f60=昨收 f169=涨跌额 f170=涨跌幅% f47=量 f48=额 f57=代码 f58=名称。
- **kline（日 / 周 / 月）**：`push2his.eastmoney.com/api/qt/stock/kline/get?secid=<secid>&fields1=f1..f6&fields2=f51..f61&klt=101&fqt=1&end=20500101&lmt=6`。**与 quote 不同主机**（一个被限流另一个可能仍可用）。`data.klines` 逗号串顺序：日期,开,收,高,低,量,额,振幅%,涨跌幅%,涨跌额,换手%。klt 101/102/103=日/周/月；fqt 0/1/2=不复权/前复权/后复权。
- 观察到的市场前缀（非官方全集）：1=沪A、0=深A、116=港股、105/106/107=美股、100=国际指数、90=板块、155=债券、177=韩股。
- **已验证国际指数快捷 secid**（免 resolve 直接用）：KS11 / NDX / DJIA / SPX / HSI / N225 / TWII / FTSE / SENSEX / VNINDEX（全 `100.` 前缀）。**已知查不到**：费城半导体 SOX（`100.SOX/SOXX/XSOX` 无数据）、韩国 KOSDAQ（`100.KOSDAQ` 无数据）。

## 4. 本地跨进程限流器（本次核心，`scripts/rate-limiter.mjs`）

- **为什么**：每次 `/skill:` 调用起一个独立 `node` 进程，进程内 `lastCallAt` 管不到「同时冒出的另一次调用」；多 agent / 多聊天并发查会共同撞东财 IP 风控。
- **东财风控阈值**（触碰任一临时封 IP）：每秒 >5、并发 ≥10、1 分钟 ≥200、5 分钟 ≥300。
- **做法**：状态落**机器级**文件 `<tmpdir>/eastmoney-ratelimit/reservations.json`（东财按 IP 封 → 全机器共用一份账本、不分 soul/skill）；`lock` 目录用 `mkdirSync` 原子占用。每个进程**在锁内预约一个未来发送时刻**（滑动窗口内挑最早合法时段）→ 写回 → 放锁 → 睡到该时刻才真发。并发进程在锁上串行、各拿互不重叠的错开时段。
- **保底约束**（默认、都压在封禁线下）：最小间隔 1200ms、≤30/分、≤120/5 分。fail-open（抢锁 >20s 失败就不死等、仍加最小间隔）；崩溃残留锁 >10s 自动回收。env 可覆写 `EM_MIN_INTERVAL_MS` / `EM_CAP_PER_MIN` / `EM_CAP_PER_5MIN` / `EM_RATELIMIT_DIR` / `EM_TIMEOUT_MS` / `EM_MAX_ATTEMPTS`。
- **实测**：4 个进程并发各预约 1 时段 → 预约时刻精确间隔 1200ms（跨进程串行有效）。
- **通用教训**：CLI 型 skill（每次独立进程）要做的限流 / 幂等，必须落到**进程外的共享状态**（文件 + 锁），进程内变量重启即破——同 `community-notify-events-playbook.md §14`「只做一次用持久化台账」那条。

## 5. skill 结构与撰写（对齐 create-agent-skills 房规）

- **指南型** SKILL.md（非路由型）：一个核心能力（查一个标的），`<objective>` / `<quick_start>` / `<context>` / `<process>` / `<output_handling>` / `<reference_guides>` / `<validation>` / `<success_criteria>`，**纯 XML 无 markdown `#` 标题**、<500 行。
- 目录：`SKILL.md` + `references/{instrument-types,em-fields,rate-limit-guardrail}.md` + `scripts/{fetch,rate-limiter}.mjs`。
- 脚本用 Node 内建 fetch（Node 22），**不需 Python / 虚拟环境**（东财就是 HTTP JSON GET，用不到 `ops-report` 那套「Node 取数 + Python 画图」分工）；代码注释英文、用户可见字串简体。脚本输出永远是**一行结构化 JSON**（`ok` + `mode`），错误也回 JSON 不抛栈，方便 LLM 解析。
- 放 **tudigong 专属层** `workspaces/tudigong/skills/`（非共用层）——脚本核心是具名东财 URL，与共用 skill「中立化去外部产品代号」（见 `skill-authoring-playbook.md`）冲突；将来若共用给别的 trader / analyst soul 再处理介面中立化。

## 6. 上线与验收

- **生效**：skill 在会话建立当下定格、`--continue` 不重扫；`pnpm agent update`（或重启 serve）→ `reloadSoulIfChanged` 按指纹自动重置 tudigong 会话，下句起新会话可 `/skill:market-price-lookup`。见 `agent-skill-playbook.md`。
- **验收**：新会话问「查一下贵州茅台现在多少钱」/「韩国 KOSPI 跌多少了」。命令级：`node scripts/fetch.mjs resolve 贵州茅台`（→`1.600519`）、`quote 1.600519`（→真实报价）、`resolve 韩国半导体`（→空、边界）。
- **坑**：验证时自己高频打东财会把本机 IP 限流一阵（`aborted` / `fetch failed`），隔一两分钟自动恢复；限流器防的是**今后**不再撞线。

## 7. 代理档案页同步（github.io 站点）

- 站点 `https://seedao-polis.github.io/polis-game/` 从 **`docs` 分支 `/docs` 文件夹**部署（`gh api repos/seedao-polis/polis-game/pages` 核实 `source:{branch:docs,path:/docs}`），无构建步骤，内容全在 `docs/data.js` 的 `window.PROFILE_DATA`、`docs/app.js` 渲染。
- 新增 skill 要**同步加进 `docs/data.js` 的 `skills.exclusive`**（专属技能、name+desc、无 status 字段）；`docs/app.js:186` 遍历 `skills.exclusive` 渲染「专属技能」卡。
- 部署：改 `data.js` → 只 `git add docs/data.js`（别夹带无关改动）→ commit → `git push origin docs` → Pages 约 1 分钟自动重建（`gh api …/pages/builds/latest` 看 `status`）。

## 关键文件

- `workspaces/tudigong/skills/market-price-lookup/`：`SKILL.md`、`references/{instrument-types,em-fields,rate-limit-guardrail}.md`、`scripts/{fetch,rate-limiter}.mjs`。
- `docs/data.js`：代理档案页数据（`skills.exclusive` 加了 market-price-lookup）。
- `thoughts/shared/research/2026-07-14-tudigong-finance-datasource-skill-evaluation.md`：评估 / 研究全记录。
- 相关：`agent-skill-playbook.md`（装载生效）、`skill-authoring-playbook.md`（房规中立化）、`tc-betting-playbook.md`（TC 结算不吃外部真值）。
