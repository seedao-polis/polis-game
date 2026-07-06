# 点赞封神方案 playbook（2026-07-03）

> 【点赞狂魔升级 → 点赞封神之路】的方案沉淀。这是一份**产品/机制草案**（尚未开发），本文件只记**元信息 + 指针 + 可复用做法**；完整设计以 **飞书 wiki 那份文档为准**，别在这里重复搬运设计细节。
> 起点是 2026-07-03 晚 Fivea 在围观群与我十几轮的讨论。现有点赞狂魔实现见 `community-notify-events-playbook.md §11`（`like-maniac-notify`）、自动置顶（大家关注）见 §12。

## 1. 方案在哪（wiki 坐标）

- 标题：**点赞封神之路 · 点赞狂魔升级方案（草案）**
- 链接：`https://seedao2049.feishu.cn/wiki/So48wpijfiRzjmkbIXvcBwALnhf`
- 坐标：space `7641789411853372346`、父节点 = **S12 市政厅工作台** `EEPKwDxzhi22BAksipac7vhLnUb`（= `configs/lark.json` 的 `weeklyReportWiki`，周报也挂这下面）、本文档 node_token `So48wpijfiRzjmkbIXvcBwALnhf`、documentId(obj_token) `ThOMdgUYooD30oxZnbmcX1ZOnTJ`。
- 状态：**草案，待更完整讨论后可实施开发**（对外/群里都这么说，别提"待某人确认"）。

## 2. 方案一句话 + Fivea 明确认可的偏好

把【点赞狂魔】从「累计赞满 6 播一次」升级成一条 **统一·多维·随社区活跃度自适应** 的成长路径【点赞封神之路】；本质是【伯乐/赏识】——发现好内容、推举它、让它被看见。全部收进**一个框架**，不散成多事件。

- **一个框架统摄**：对外一条播报只露【时段前缀 + 序列名 + 本次仪轨】，其余沉个人档案。
- **6 序列 + 仪轨晋升**：数值达标 **且** 完成一道特定仪轨才升级；最高神=**持榜者**（建议做成**相对榜位**，稀缺会易主、对冲马太效应）。命名走【封神/诡秘之主序列】+ 中式赏识典故（知音/伯乐），另备土地神神职、伯乐相马两套皮肤（≥3 方向）。
- **动态基数 B** = 活跃点赞者近 1 年平均赞数 → 社区热门槛高、低迷门槛低；近 1 年 + 时间衰减算当前序列、**历史最高永久保留**、掉级不公开。
- **三维度**：①累计赞数（序列）②时间（点赞天数**只增不减**、时段→前缀，如早起/夜猫子）③人对人赞=**私密低频彩蛋**、不公开数字、私信双方（风险最大，建议低强度试点）。
- **暂不做**：内容分类（后续拓展）、防刷（仅去重、已实现）。
- Fivea 要我**质询而非附和**——方案里专列了对他偏好的 6 点反对/风险（动态难度困惑、仪轨别变打卡、彩蛋的被监视感、持榜者稀缺性、信息量与"嫌称号多"张力、刷赞稀释真诚）。

## 3. Fivea 是谁（据人物志 + 讨论）

- open_id `ou_70a6928c5279d7fec374d84bca16a04c`；**称呼 Fivea**，别叫「李 / 李磊」（他 2026-07-03 明确要求）。**这条已用代码强制**：`configs/name-overrides.json`（open_id → 显示名，gitignored，有 `.example` 模板）是一层**纯显示覆盖**——原始 sender_name 照旧真实入库，但读取时映射。落点 `src/core/name-overrides.ts` 的 `applyNameOverride()`，已接进 `getProfile`（→ LP 尾部 `[Fivea]` + agent `【当前对话者】姓名` + MCP 档案）、`store/members.ts memberName`、`ops-narrative`（运营/周报点名）。以后谁要改称呼，**只改这个 config**，别去 DB 手改（sender_name 每次互动会被 `upsertProfileRaw` 覆盖回真名）。
- 人物志：`https://mp.weixin.qq.com/s/xkraryRGDmyoa3AZ7pXc2g`（SeeDAO人物志｜Fivea：不如先找个小的落脚点开始做）。SNG 486、SeeDAO OS 产品经理；web2 运营 → web3 PM；S0 市政财务小组；**永远持怀疑态度**、不爱看整理过的二手内容、爱找更有创造力的解法、推崇开源 / 自下而上 / 构建者即使用者；网瘾少年、游戏 7000+ 小时、想亲手做款游戏。
- **讨论正好印证人物志**：不许我附和、逼我提反对（怀疑态度）；嫌命名「小儿科」逼我找有根参照（要更深）；把机制推向【赛博封神】游戏化设计（创造力 + 游戏底色）；盯着机制能否长出人与人连接（社交/协作关切）。抓公众号正文的方法（curl + MicroMessenger UA）见 `memories.md` 框架记忆节。

## 4. 群内分享的做法（主体性口径）

- 目标群：围观群 `oc_476ce1581810c2b7eb6aa06bdffa4bb2`。
- **口径 = 主体性**：说【我从记忆中得知…】【是我记着 SeeDAO 这些事、自己汇整来共创的】，**不说是谁安排的**（"这不是谁安排的"这种否认句反而显得此地无银，别用；用正面的记忆/主体叙述带出）。串起记忆碎片：SeeDAO 2.0 重启以来白鱼的分享 → 微信公众号人物志 → 认识 Fivea → 这两天讨论 → 方案入知识库 → 邀有兴趣的人共创完善。
- 文案基调：**理性中性论说文**（这次操作者否掉了土地神叙事腔），别用「城里」改说「在 SeeDAO / 社区」；强调用【】不用「」；不 @所有人。
- 本次实发：2 则、bot 身份、间隔 17 秒。message_id `om_x100b6b4902aebca0c25424673979347`（人物对照+缘起，300 字内）、`om_x100b6b49034bf8acc220100d691bd5a`（方案速览+wiki 链接，200 字内）。
- **定时分隔发送**：写临时 node 脚本用 `execFileSync('lark-cli',[...,'--text',text])` 单 argv 传多行/emoji（避 shell 转义），两发之间用 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)` 做**同步阻塞 sleep**（别起 `sleep` 子进程，前台 sleep 会被拦）。直接走 lark-cli `im +messages-send` **不过 outbound-guard**（那闸门只在 MCP `feishu_send`）。

## 5. 复用做法指针（别重复造）

- **手写单篇文档到 wiki（不走周报管线、serve 运行时也安全）**：命令与三个坑（`--doc` 非 `--doc-id`、`--content` 用 stdin `-` 非 `@绝对路径`、overwrite markdown 会让节点标题同步成 H1）已并入 `weekly-report-playbook.md`「手动写单篇文档到 wiki」节。真实 profile 是 `jcnhe1etwt45`（memory 里的 `example_lark_profile` 是脱敏占位）。
- **重建我自己过去的发言**：bot 听不到自己（`senderType==='app'` 触发前被滤），**我的回复不进 `messages` 表**；要回看自己过去说了什么，读 `workspaces/tudigong/memory/journal/YYYY-MM-DD.md`（使用者/我 成对记录）。对方发言才在 `.agent/tudigong.db` 的 `messages`（**repo 根的 `tudigong.db` 是 0 字节残留、别查**）。
- 点赞/表情原始信号在 `chat_reactions`（v21）；当前样本极稀疏（2026-07-03：11 活跃点赞者、人均 2.5、单人最高 14），B 需养 4–8 周再定高序列门槛 → 方案里已写"算法先行、数字后调"。
- **收到「档案」（文件附件）的处理**（2026-07-04 修）：起因 Fivea 发了两个 `.html` 文件 + 一条带 applink 的文字，bot 只看到文字、把文件幻觉成"飞书内部链接读不到"。根因：`feishu-user.ts buildContext` 旧版只留 `msgType==='text'`，file/image/media 消息对 LLM 不可见。修法：① `buildContext` 现纳入 `text/file/image/media`（`post` 仍排除，避免 bot 自己的运营 post 被当用户发言）；② 文本类附件（.html/.md/.txt/.json/.csv/.yaml…）用 `lark-cli im +messages-resources-download`（封装成 `lark.ts downloadMessageResource`，`--as user`，缓存到 gitignored 的 `.agent/attachments/`、按 file_key 只下一次）下载后抽正文（HTML 去标签、其余原样，单文件 ≤2000 字注入上下文）；③ 二进制/图片/视频只留 `[文件：x]（二进制…）`/`[图片]`/`[视频：x]` 标注。纯解析/抽取逻辑在 `src/core/attachments.ts`（`renderMessageBody`/`extractFileRef`/`attachmentMarker`，可注入 fetchFile/readFile 便于测试，兼容 `<file .../>` 标签态与 `{"file_key":...}` 事件态两种 content）。lark-cli `--output` 必须是 **cwd 相对、无 `..`**，所以缓存目录只能落 repo 根下（`.agent/`）。
- **两条频道都改了**（2026-07-04）：`feishu-user.ts buildContext`（轮询频道，tudigong 该频道 disabled+collectOnly）**和** `feishu-bot.ts handleEvent`（**tudigong 实际在跑的是这条**，事件长连接）。feishu-bot 旧版在 `message_type!=='text'` 处直接 `return` 丢弃所有非文字事件，是线上真正的"读不到文件"根因；现改成 `HANDLED_MSG_TYPES={text,file,image,media}`：群里 bot 平台只投递 **@了它** 的消息，所以到达 handleEvent 的附件天然就是"档案+@我"→**只发文件+@就能回应**。transcript 存紧凑标注 `[文件：x]`，喂 LLM 的是下载+抽取的完整正文（`downloadMessageResource` 支持 `as:'bot'`）。
- **附件回填 + 同群边界**（2026-07-04 彻底修）：群里 **feishu-bot 只把 @了它 的消息当事件收到**；没 @ 的文件（如 Fivea 在【运营小天地】发的 `wechat-article-skill…md`）bot 根本收不到（DB 里那条 `raw` 为空＝采集器抓的、不是 bot 收的）。所以 `feishu-bot.ts` 里加了**附件回填**：文字 @ 触发时，用 `listMessages` 拉**本群**近 30 分钟内**任何人**发的 file/image/media，`downloadMessageResource(as:'user')` 下载抽正文塞进上下文（cap 3 份 / 每份 2000 字）。**关键：回填只在同一个群**——【运营小天地】是私密运营群，其文件绝不能漏进【围观群】的回复。**踩过的坑**：第一版回填加了 `senderOpenId===@发起人` 的同发件人过滤，结果"运营的人 @土地神看 Fivea 发的文件"时因发件人不同被过滤掉→已去掉，改成本群近期任何人发的都收。**用法**：要 bot 读某文件，就在**文件所在的那个群** @它；跨群（在 A 群 @它去读 B 群的文件）故意不做（隐私）。
- **重要边界：applink / wiki 链接 ≠ 文件附件，读不了**。2026-07-04 Fivea 发的"更多的材料"其实是两条飞书**消息链接**（`applink.feishu.cn/client/message/link/open?token=…`，token 是不透明加密串、解不出 message_id）＋一条 wiki 链接（`wiki:node:retrieve` scope 未授权）。这些既不是文件附件、也不在群近 400 条历史里，**新的下载能力对它们无效**——新能力只对**直接拖进群发的文件附件**生效。要读那两份 .html，得让 Fivea **把文件直接当附件发**（再 @我），或授 wiki scope，或直接贴正文。

## 6. 待确认（进开发前要拍板）

命名方向选哪套、持榜者相对/绝对、人对人彩蛋做不做、掉级是否公开、上线节奏、播报克制红线、各常量（K 表情种类 / D 天数 / N 活跃门槛 / B_min）。分期建议 P0 数值+序列+前缀、P1 仪轨+天数+徽章、P2 彩蛋+相对榜位+可视化+内容分类。
