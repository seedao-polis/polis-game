// Profile data for the tudigong Agent page.
// All user-visible strings are in Simplified Chinese.
// Edit this file to update the page content.
window.PROFILE_DATA = {

  // Google Form configuration — replace placeholders before going live.
  config: {
    googleFormBase: 'https://docs.google.com/forms/d/e/REPLACE_WITH_FORM_ID/viewform',
    googleFormEntrySection: 'entry.REPLACE_WITH_ENTRY_ID',
    repoUrl: 'https://github.com/seedao-polis/polis-game'
  },

  // Hero / identity section data.
  hero: {
    emoji: '🏯',
    name: '城邦土地神 · 土地公',
    nameEn: 'tudigong',
    tagline: '我是 SeeDAO 数字城邦的土地神，住在飞书里，记得城里每个人的故事——推播城邦活动、帮成员安顿、陪大家把社区参与的事办成。',
    subtitle: '这是一个由社区共同维护的 Agent 档案，欢迎大家查看它的能力、提出建议',
    chips: [
      'serve 常驻',
      'bot + user 双身份',
      'LP 点数经济',
      '记忆隔离',
      '心跳巡查'
    ]
  },

  // Permissions and identity section data.
  permissions: {

    // Dual identity: bot and user roles.
    identity: [
      {
        role: 'bot',
        label: 'tudigong-bot',
        description: '以机器人账号回复被 @ 的消息；回复不加任何前缀，直接呈现内容。'
      },
      {
        role: 'user',
        label: 'tudigong-user',
        description: '以操作者身份静默采集群资料；collectOnly 模式，只采集不回复。'
      }
    ],

    // Lark profile note (no real IDs exposed).
    larkProfile: '已配置飞书应用 Profile（含 bot 身份）。每条飞书命令均需携带 --profile 参数，否则请求会被拒绝。',

    // Three-tier group classification.
    groupTiers: [
      {
        tier: 'public',
        label: '公开群',
        description: '对外观察者群。只介绍公开资讯，不透露任何内部事务。未标记的群默认归入此级。'
      },
      {
        tier: 'member',
        label: '会员群',
        description: '面向社区会员的事务群。可处理会员参与及日常社区活动相关问题。'
      },
      {
        tier: 'work',
        label: '工作群',
        description: '核心工作成员群。可讨论内部运营、配置变更等工作事项。'
      }
    ],

    // MCP tool list (11 tools).
    mcpTools: [
      { name: 'memory_remember', desc: '把重要事项写入长期记忆，支持四层命名空间隔离。' },
      { name: 'memory_search', desc: '以关键字搜索长期记忆，跨命名空间检索。' },
      { name: 'feishu_send', desc: '主动发飞书消息到指定群，经 outbound-guard 闸门过滤后发出。' },
      { name: 'profile_get', desc: '查询用户的 LP 余额与已获得的徽章列表。' },
      { name: 'pt_grant', desc: '向指定用户增加或扣除 LP 积分，并记录变动原因。' },
      { name: 'badge_award', desc: '授予徽章给指定用户，可触发群公告与私信通知。' },
      { name: 'leaderboard', desc: '查看 LP 排行榜，默认返回前 10 名。' },
      { name: 'message_search', desc: '全文搜索已采集的群消息（FTS5 trigram 索引）。' },
      { name: 'peer_list', desc: '列出当前同群中其他在线的 Agent soul。' },
      { name: 'peer_recv', desc: '读取暗线信箱中的未读消息，用于 Agent 间协作。' },
      { name: 'peer_broadcast', desc: '向同群所有同事 Agent 广播暗线 cue，驱动多 Agent 协同。' }
    ],

    // Outbound guard gates description.
    outboundGuard: {
      gate1: {
        label: '闸门一：无意义内容拦截',
        desc: '拦截空白内容、测试占位词（测试 / TEST / ping / pong / 123 等）、以及短重复 ASCII 字符串（如 aaaa / 1111）。'
      },
      gate2: {
        label: '闸门二：群发洪水拦截',
        desc: '120 秒内相同内容发送到 3 个以上不同群时触发拦截，防止 LLM 把相同消息刷屏群发。'
      },
      note: '此闸门对所有 Agent 生效，不限 tudigong。'
    },

    // Operational limits.
    limits: [
      { label: '静默时段', value: '每日 22:00 – 次日 08:00' },
      { label: '每日触发上限', value: '20 次' },
      { label: '心跳触发概率', value: '80%' },
      { label: '每次 LLM 回复扣费', value: '0.1 LP' },
      { label: '跨人记忆隔离', value: '严格隔离，A 无法读取 B 的个人记忆' }
    ]
  },

  // Database section data — 17 community-relevant tables.
  database: {
    intro: '土地公使用两个数据库：tudigong.db 为本 Agent 专属库，shared.db 为全 Agent 共用库（LP 积分与徽章体系）。',
    techNote: '另有 7 张纯技术表（错误账本、待发回复、迁移版本等）未在此展示。',
    tables: [
      {
        name: 'chats',
        db: 'tudigong.db',
        desc: '监听的社区群目录，记录 Agent 接入的所有飞书群及其状态。',
        fields: ['chat_id — 飞书群唯一标识', 'name — 群名称', 'lark_profile — 使用的飞书 Profile', 'first_seen — 首次发现时间', 'dissolved_at — 群停服时间（NULL 表示活跃）']
      },
      {
        name: 'messages',
        db: 'tudigong.db',
        desc: '从所有监听群采集的消息，含 FTS5 trigram 全文搜索索引。',
        fields: ['message_id — 飞书消息唯一标识', 'chat_id — 所属群', 'sender_name — 发送者显示名', 'msg_type — 消息类型（text / file / image 等）', 'create_time — 创建时间（毫秒）']
      },
      {
        name: 'chat_members',
        db: 'tudigong.db',
        desc: '所有监听群的成员名册，包含从未发言的成员；离群后保留记录。',
        fields: ['chat_id + open_id — 复合主键', 'name — 显示名称', 'present — 是否仍在群（1/0）', 'first_seen — 首次出现时间', 'last_seen — 最后在群时间']
      },
      {
        name: 'member_sync_rounds',
        db: 'tudigong.db',
        desc: '每 5 分钟同步一轮群成员，记录各轮次的人数统计，驱动运营数据报告。',
        fields: ['synced_at — 同步时间（唯一索引）', 'chat_count — 本轮监听群数量', 'present_total — 在群人数合计', 'joined_count / left_count — 本轮加入/离开人数', 'present_distinct — 去重后的在群人数']
      },
      {
        name: 'profiles',
        db: 'shared.db',
        desc: '玩家档案，记录每位曾与 Agent 互动过的用户的 LP 余额与等级。',
        fields: ['open_id — 用户唯一标识', 'name — 显示名称', 'pt_balance — LP 余额（保留一位小数）', 'level — 等级', 'last_seen — 最后互动时间']
      },
      {
        name: 'pt_ledger',
        db: 'shared.db',
        desc: 'LP 变动分类账，每次积分增减均记一笔，保留完整追踪历史。',
        fields: ['user_open_id — 关联用户', 'delta — 增减量（负数为扣分）', 'reason — 原因码（llm_reply / daily_checkin 等）', 'ref_message_id — 关联消息', 'created_at — 发生时间']
      },
      {
        name: 'checkins',
        db: 'shared.db',
        desc: '每日签到记录，UNIQUE(user_open_id, checkin_date) 防止同一用户当日重复签到。',
        fields: ['user_open_id — 签到用户', 'checkin_date — 签到日期（YYYY-MM-DD）', 'pt_awarded — 当次获得 LP', 'created_at — 签到时间']
      },
      {
        name: 'badges',
        db: 'shared.db',
        desc: '徽章定义表，包含徽章的语义信息、图片路径、职称、类型等丰富字段。',
        fields: ['badge_id — 徽章唯一标识', 'name — 徽章名称', 'description — 说明文字', 'emoji — 表情符号', 'type / category — 类型与分类']
      },
      {
        name: 'user_badges',
        db: 'shared.db',
        desc: '用户已获得的徽章记录，含发放者与备注信息。',
        fields: ['user_open_id — 持有者', 'badge_id — 徽章 ID', 'awarded_at — 发放时间', 'awarded_by — 发放者', 'note — 备注文字']
      },
      {
        name: 'activities',
        db: 'tudigong.db',
        desc: '系统活动记录（迎新、签到、里程碑等），驱动各类事件触发逻辑。',
        fields: ['type — 活动类型', 'actor_open_id — 触发者', 'chat_id — 相关群', 'payload — 附加数据（JSON）', 'created_at — 发生时间']
      },
      {
        name: 'event_types',
        db: 'tudigong.db',
        desc: '推播事件定义，每种事件含图片、渲染配置、Markdown 模板及目标群。',
        fields: ['event_type_id — 事件唯一标识', 'title — 标题', 'scope — 范围（global / personal）', 'target_chat_id — 目标群', 'enabled — 是否启用']
      },
      {
        name: 'event_dispatches',
        db: 'tudigong.db',
        desc: '事件发送记录，每次事件触发均记录状态与飞书消息 ID。',
        fields: ['event_type_id — 事件类型', 'trigger_reason — 触发原因', 'status — 状态（pending / sent / failed）', 'message_id — 飞书消息 ID', 'sent_at — 实际发送时间']
      },
      {
        name: 'calendar_event_rsvp_rounds',
        db: 'tudigong.db',
        desc: '活动报名时序表，每 5 分钟同步未来活动的报名人数，用于里程碑推播与运营图表。',
        fields: ['synced_at + event_id — 唯一复合索引', 'title — 活动标题', 'start_time / end_time — 活动时间', 'accepted — 已接受报名数', 'signup_total — 所有非移除出席者']
      },
      {
        name: 'doc_view_events',
        db: 'tudigong.db',
        desc: '文件访问记录，每小时轮询飞书 wiki 与个人云端，append-only。',
        fields: ['file_token — 文件唯一标识', 'file_type — 文件类型（docx / sheet 等）', 'source — 来源（wiki / drive）', 'viewer_name — 访问者名称', 'last_view_time — 最后访问时间']
      },
      {
        name: 'chat_reactions',
        db: 'tudigong.db',
        desc: '群消息表情反应采集表，驱动「点赞狂魔」里程碑与「点赞封神之路」方案。',
        fields: ['message_id + reactor_open_id + emoji_type — 复合主键', 'chat_id — 所属群', 'action_time — 反应时间', 'first_seen — 首次采集时间']
      },
      {
        name: 'pinned_messages',
        db: 'tudigong.db',
        desc: '热门自动置顶消息记录，当消息获得 ≥N 人不同表情反应时自动置顶。',
        fields: ['message_id — 主键', 'chat_id — 所属群', 'reactor_count — 反应人数', 'pinned_at — 置顶时间']
      },
      {
        name: 'memory_items',
        db: 'tudigong.db',
        desc: '长期记忆存储，四层命名空间实现严格的跨人记忆隔离。',
        fields: ['namespace — 命名空间（global / group:{chat} / user:{id} / group_user:{chat}:{id}）', 'key — 可选分类键', 'content — 记忆内容', 'visibility — 可见性（private / admin_only）', 'expires_at — 到期时间（NULL 表示永久）']
      }
    ]
  },

  // Skills section data.
  skills: {

    // Exclusive skill for this agent.
    exclusive: [
      {
        name: 'agent-self-heal',
        desc: '诊断并修复损坏的执行器会话（HTTP 400 持续回传时使用），通过 pnpm agent doctor --fix 隔离损坏会话。'
      }
    ],

    // Shared skills available to all agents.
    shared: [
      { name: 'create-agent', desc: '从 _template 构建新的 Agent workspace，全程有引导向导。' },
      { name: 'create-agent-skills', desc: '元技能，用于为 Agent 创建新的 Skill 文件。' },
      { name: 'create-badge', desc: '设计→导入→发放→验收徽章的完整流程。' },
      { name: 'create-event', desc: '设计→配置→配图→验收推播事件的完整流程。' },
      { name: 'group-policy-design', desc: '设计群组三级分类政策（public / member / work）。' },
      { name: 'lp-usage-design', desc: 'LP 经济设计指南，含 lp_runway.py 续航模拟器。' },
      { name: 'onboard-lark-bot', desc: '把 Agent 接上飞书当 Bot 的完整接入流程。' }
    ],

    // Current gameplay abilities and features.
    // status: "上线" | "草案" | "停用"
    abilities: [
      { name: 'serve vs CLI 对话身份切换', status: '上线', desc: 'serve 模式对面是居民；CLI 模式才是操作者，行为规则不同。' },
      { name: 'LP 点数经济', status: '上线', desc: '初始 120 LP、每次 LLM 回复 -0.1、每日 05:00 补底到 10。' },
      { name: '每日签到（+3 LP）', status: '上线', desc: '命令 sign / 签到，每日一次，不走 LLM，即时结算。' },
      { name: '徽章系统', status: '上线', desc: '导入→发放→逐人私信→群公告；支持 pnpm agent badge CLI 操作。' },
      { name: 'LP 排行榜', status: '上线', desc: '通过 MCP 工具 leaderboard 查看前 N 名 LP 排名。' },
      { name: '活动报名采集（每 5 分钟）', status: '上线', desc: '采集飞书日历未来活动的报名人数时序，存入 calendar_event_rsvp_rounds。' },
      { name: '文件访问记录采集（每 1 小时）', status: '上线', desc: '采集飞书 wiki 与个人云端的文件访问记录，存入 doc_view_events。' },
      { name: '运营数据日报 / 月报', status: '上线', desc: '深色 16:9 图表，每日 04:59 推送到 Telegram 与飞书运营群。' },
      { name: '日报 AI 叙事洞察', status: '上线', desc: '每日 04:59 LLM map-reduce 把当天对话写成 ≤500 字摘要。' },
      { name: '每周社区动态周报', status: '上线', desc: '每周四 21:00，五面向 Markdown 格式，写到飞书 wiki docx。' },
      { name: '心跳后台主动巡查', status: '上线', desc: '每 60 分钟触发（tudigong），22:00~08:00 静默，触发概率 80%。' },
      { name: 'outbound-guard 发送闸门', status: '上线', desc: '拦测试/占位内容 + 拦 120s 内 ≥3 群群发刷版，对所有 Agent 生效。' },
      { name: '迎新自动推播', status: '上线', desc: '新人入群时触发 welcome-party 事件，含自定义底图。' },
      { name: '潜水者发现推播', status: '上线', desc: '潜水成员被发现时触发 lurker-discovered 事件通知。' },
      { name: '课程报名里程碑推播', status: '上线', desc: '课程报名跨 10/25/40/50/60/75/90 人时推播围观群。' },
      { name: '围观群人数里程碑推播', status: '上线', desc: '围观群人数每达 100 整数倍时自动推播。' },
      { name: '市政厅提案决议通知', status: '上线', desc: '市政厅做出决议时手动触发推播运营群。' },
      { name: '点赞狂魔里程碑', status: '上线', desc: '用户累计点赞跨 6 的倍数时，奖励 LP+20 并推播围观群。' },
      { name: '热门消息自动置顶', status: '上线', desc: '消息获 ≥N 人不同表情反应时自动置顶（阈值由配置驱动）。' },
      { name: 'A2A 暗线广播（Agent 协作）', status: '上线', desc: '飞书 bot 互不可见，通过 data/peer-bus 暗线信箱传递协作 cue。' },
      { name: '多人多群记忆隔离', status: '上线', desc: '四层命名空间（global / group / user / group_user），严格隔离，A 无法读取 B 的记忆。' },
      { name: 'LP 动态评分', status: '停用', desc: 'LLM 回复后输出 LP_JUDGE 类别按类给分，tudigong 目前停用，改用固定 -0.1。' },
      { name: '跨 App 身份归并', status: '上线', desc: '同一人在不同飞书 App 下的 open_id 归并，LP 跨 Agent 共通。' },
      { name: 'Telegram 运维日志镜像', status: '上线', desc: 'serve 日志单向推送到 Telegram，含日志分级分类及 token 到期提醒。' },
      { name: '点赞封神之路', status: '草案', desc: '六序列/仪轨/动态基数/持榜者设计，方案存于飞书 wiki，待实现。' },
      { name: '文字附件内容读取', status: '上线', desc: 'Bot 被 @ 时可读取同群近 30 分钟内的文字附件（.html / .md / .txt 等）。' },
      { name: '会话自愈（agent-self-heal）', status: '上线', desc: '通过 Skill 运行 pnpm agent doctor --fix 隔离并修复损坏的执行器会话。' },
      { name: '撤回消息', status: '上线', desc: '通过 pnpm agent unsend <message_id> 撤回已发出的飞书消息。' }
    ]
  }
};
