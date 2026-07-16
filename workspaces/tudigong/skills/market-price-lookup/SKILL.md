---
name: market-price-lookup
description: 查询东方财富能查到的任意标的行情——A股/港股/美股、ETF/基金、全球指数（如韩国KOSPI/KS11）、板块、债券、期货等——支持按名称或代码搜索、即时报价、日/周/月K线。当社区成员问某个股票/指数/基金现在多少钱、涨跌多少、近期走势，或某场意向调查（TC）需要引用客观市场数据作背景参考时使用。免密钥，自带本地跨进程限流避免被封 IP。查无标的时如实告知、绝不臆测数字。不做实时结算。
---

<objective>
给城邦土地神一个「查任意标的行情」的能力。三种模式：
- **resolve**：把一个名字/代码解析成候选标的（每条带完整 `secid`、名称、类型），用于确认要查的到底是哪一个。
- **quote**：即时报价（最新价、今开、最高、最低、昨收、涨跌额、涨跌幅、成交量额）。
- **kline**：日/周/月 K 线历史（每根开高低收、涨跌幅）。

覆盖东方财富能查到的**所有**类型：A股、港股、美股、ETF、基金、指数、板块、债券、期货、外汇。数据走东财网页接口，免密钥、无第三方依赖。

用途场景：
- 社区成员在飞书 @ 土地神问「贵州茅台现在多少钱」「纳指昨晚涨跌多少」「韩国大盘跌了多少」，用真实数字回答，而不是凭印象或拿旧数据。
- 某场意向调查（TC，如围绕「某指数明天还会不会跌」的提案）进行中，引用当前/历史行情当**背景资料**帮社区判断。

明确不做的事：**本 skill 不参与 TC 结算**。TC 结算值是全体投注者猜测的加权平均（社区共识），框架不吃外部真实行情核对谁猜中。所以本 skill 只做「信息性回答/佐证」，不改变任何 TC 的输赢判定。
</objective>

<quick_start>
不确定标的、或名字可能撞车时，先解析：

```
node scripts/fetch.mjs resolve 贵州茅台
```

拿到候选里对的那条 `secid`，再查即时报价：

```
node scripts/fetch.mjs quote 1.600519
```

已知确切标的可跳过 resolve，直接传 secid 或裸名字（裸名字脚本自动解析取第一条）：

```
node scripts/fetch.mjs quote 100.KS11        # 韩国KOSPI 指数
node scripts/fetch.mjs quote 苹果            # 自动解析到美股 AAPL
node scripts/fetch.mjs kline 1.600519 6      # 最近 6 根日K
```
</quick_start>

<context>
- `secid = <市场前缀>.<代码>`（如 `1.600519` 沪A、`116.00700` 港股、`105.AAPL` 美股、`100.KS11` 国际指数）。前缀不用背，`resolve` 会给完整 secid。常用国际指数的快捷 secid 见 `references/instrument-types.md`。
- **限流是自动的**：所有请求走 `scripts/rate-limiter.mjs` 的跨进程本地限流器，主动压在东财封禁阈值下，你不用手动 sleep（细节见 `references/rate-limit-guardrail.md`）。
- 脚本执行环境是本机 Node（22+），不依赖 Python，也不依赖仓库其他模块。
</context>

<process>
1. **确认要查哪个标的**。
   - 名字可能撞车（同代码跨市场、同名多只）或你不确定 → 先 `resolve <名字/代码>`，从候选里挑 `name`/`type` 对的那条，记下它的 `secid`。
   - 已知确切 `secid`（如 `references/instrument-types.md` 快捷表里的国际指数）→ 直接用。
2. **判断能不能查**：`resolve` 回空 candidates（尤其 **韩国半导体/KRXSEM**）→ **不要臆测**，如实告知查不到，按需降级到 KOSPI（`100.KS11`）或引导用户去 Investing.com，**绝不拿相近标的（如 KOSDAQ 半导体）冒充**。
3. **取数**：即时涨跌用 `quote`，走势/历史用 `kline`。
4. **读回传 JSON 组织回答**（见 output_handling）。传裸名字查询时，**务必核对回传里的 `resolved.name` 是不是你要的**——不对就改传确切 secid 重查。
</process>

<output_handling>
脚本永远输出一行 JSON，据 `ok` 与 `mode`：

- `mode:"resolve"` → `candidates[]`，每条 `{secid,code,name,type,market}`，挑对的那条的 `secid`。
- `ok:true, mode:"quote"` → **先看 `source`**：
  - `source:"realtime"` → 实时报价，用 `name`/`price`/`prevClose`/`change`/`changePct`（+ `open`/`high`/`low`/`volume`）作答，例：「韩国KOSPI 现报 6890.72，涨 83.79（+1.23%）」。
  - `source:"daily-close"`（带 `stale:true`）→ **实时源暂时不可用、脚本已自动回退为最近交易日收盘**（`asOf` 是该交易日日期）。回答**必须如实说明是「{asOf} 收盘、非实时」**，例：「实时源暂时不稳，韩国KOSPI 最近交易日（07-14）收 6874.07，+0.99%」。
  两种都留意 `resolved`（裸名字查询实际匹配到的标的）/ `alternatives`，核对没选错。
- `ok:true, mode:"kline"` → `bars` 按日期升序，每根有 `date/open/close/high/low/changePct` 等，取最后一根说当日、或串起来说走势。
- `ok:false, reason:"not-found"` → 搜不到这个名字/代码，照 `hint` 如实告知，按需降级/引导，别编数字。
- `ok:false, reason:"no-data"` / `reason:"error"` → **实时与日K都拿不到**（被限流/拥堵或标的不支持）。如实说「行情源暂时不可用，稍后再试」，别臆测。（`quote` 已内建实时→日K 自动回退，走到这步是两个主机都不行。）
</output_handling>

<reference_guides>
- `references/instrument-types.md` — secid 市场前缀、resolve 优先原则、常用国际指数快捷表、已知查不到的边界（KRXSEM/KOSDAQ/SOX）。
- `references/em-fields.md` — resolve/quote/kline 三个接口路径与字段编号含义、klt/fqt 参数。扩展或排错时看。
- `references/rate-limit-guardrail.md` — 东财风控阈值 + 本地跨进程限流器原理、状态文件、可调参数、使用规则。**打算连查多个前读这份。**
</reference_guides>

<validation>
- `node scripts/fetch.mjs resolve 贵州茅台` 回 `ok:true` 且候选含 `1.600519`。
- `node scripts/fetch.mjs quote 1.600519` 回 `ok:true` 且 `name` 是「贵州茅台」、有真实 price。
- `node scripts/fetch.mjs resolve 韩国半导体` 回 candidates 为空（边界确认）。
- 传不存在的名字回 `ok:false,reason:not-found`（不崩、给降级提示）。
- 被限流时回 `ok:false,reason:error`，据此如实告知而非编数。
- 限流器：多个进程并发调用会被自动错开（≥1.2s 间隔），不触发封 IP。
</validation>

<success_criteria>
- 能把社区口语里的标的名对到正确 secid 并取到真实即时/历史数字作答，覆盖 A股/港股/美股/ETF/基金/指数/板块等。
- 对查不到的标的（尤其 KRXSEM）如实降级，绝不用相近标的或臆测数字冒充。
- 连查多个标的时靠本地限流器自动错开，不触发 IP 封禁。
- 始终清楚：本 skill 只做信息性回答，不参与也不影响任何 TC 结算。
</success_criteria>
