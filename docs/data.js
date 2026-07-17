// Profile data for the tudigong agent page.
// All user-visible strings are in Simplified Chinese.
// Edit this file to update the page content.
window.PROFILE_DATA = {

  // Google Form configuration — replace placeholders before going live.
  config: {
    googleFormBase: 'https://docs.google.com/forms/d/e/1FAIpQLSdL_fe5US9MrcXGxqGbmRbdNJHJs3CKjMZtN86_clfqjS5_qw/viewform',
    googleFormEntrySection: 'entry.438915447',
    repoUrl: 'https://github.com/seedao-polis/polis-game'
  },

  // Hero / identity section data.
  hero: {
    emoji: '🤖',
    name: '城邦土地神',
    nameEn: 'github.com/seedao-polis/polis-game',
    tagline: '我是 SeeDAO 数字城邦的土地神，住在飞书里，记得城里每个人的故事——推播城邦活动、帮成员安顿、陪大家把社区参与的事办成。',
    subtitle: '这是一个由社区共同维护的代理档案，欢迎大家查看它的能力、提出建议',
    chips: [
      'serve 常驻',
      'bot + user 双身份',
      'LP 点数经济',
      '记忆隔离',
      '心跳巡查'
    ]
  },

  // Skills section data.
  skills: {

    // Exclusive skill for this agent.
    exclusive: [
      {
        name: 'agent-self-heal',
        from: 'Ricky',
        desc: '诊断并修复损坏的执行器会话（HTTP 400 持续回传时使用），通过 pnpm agent doctor --fix 隔离损坏会话。'
      },
      {
        name: 'market-price-lookup',
        from: 'Ethan',
        desc: '查东方财富能查到的任意标的行情——A股/港股/美股、ETF/基金、全球指数（如韩国 KOSPI）、板块等；支持按名称或代码搜索、即时报价与日/周/月 K 线，自带跨进程本地限流避免被封 IP。'
      }
    ],

    // Shared skills available to all agents.
    shared: [
      { name: 'create-agent', desc: '从 _template 构建新的代理 workspace，全程有引导向导。' },
      { name: 'create-agent-skills', desc: '元技能，用于为代理创建新的 Skill 文件。' },
      { name: 'create-badge', desc: '设计→导入→发放→验收徽章的完整流程。' },
      { name: 'create-event', desc: '设计→配置→配图→验收推播事件的完整流程。' },
      { name: 'group-policy-design', desc: '设计群组三级分类政策（public / member / work）。' },
      { name: 'lp-usage-design', desc: 'LP 经济设计指南，含 lp_runway.py 续航模拟器。' },
      { name: 'onboard-lark-bot', desc: '把代理接上飞书当 Bot 的完整接入流程。' }
    ],

    // Current gameplay abilities and features.
    // status: "上线" | "草案" | "停用"
    abilities: [
      { name: 'serve vs CLI 对话身份切换', status: '上线', desc: 'serve 模式对面是居民；CLI 模式才是操作者，行为规则不同。' },
      { name: 'LP 点数经济', status: '上线', desc: '初始 120 LP、每次 LLM 回复 -0.1、每日 05:00 补底到 10。' },
      { name: '每日签到（+3 LP）', status: '上线', desc: '命令 sign / 签到，每日一次，不走 LLM，即时结算。' },
      { name: '徽章系统', status: '上线', desc: '导入→发放→逐人私信→群公告；支持 pnpm agent badge CLI 操作。' },
      { name: '意向调查（TC）', status: '上线', desc: '@ 土地神发起议题，群内 @ 投注 LP；到期自动按社区共识结算（连续＝加权平均、离散＝最高票），赢家按 LP 占比瓜分奖池（总投注×1.05，多的 5% 是系统补贴）。' },
      { name: '社区预测（BET）', status: '上线', desc: '仿意向调查但仅离散选项，结果不自动算——由持有【社区预测裁判】徽章的成员在事件揭晓后人工宣布，押中者瓜分奖池（总投注×1.05）。' },
      { name: '公益宝箱', status: '上线', desc: 'owner 专属的虚拟 LP 账户，存入/转出仅 owner。每次社区预测结算，系统额外铸造奖池的 10% 自动注入，不从赢家奖金里扣。' },
      { name: 'LP 排行榜', status: '上线', desc: '通过 MCP 工具 leaderboard 查看前 N 名 LP 排名。' },
      { name: '活动报名采集（每 5 分钟）', status: '上线', desc: '采集飞书日历未来活动的报名人数时序，存入 calendar_event_rsvp_rounds。' },
      { name: '文件访问记录采集（每 1 小时）', status: '上线', desc: '采集飞书 wiki 与个人云端的文件访问记录，存入 doc_view_events。' },
      { name: '运营数据日报 / 月报', status: '上线', desc: '深色 16:9 图表，每日 04:59 推送到 Telegram 与飞书运营群。' },
      { name: '日报 AI 叙事洞察', status: '上线', desc: '每日 04:59 LLM map-reduce 把当天对话写成 ≤500 字摘要。' },
      { name: '每周社区动态周报', status: '上线', desc: '每周四 21:00，五面向 Markdown 格式，写到飞书 wiki docx。' },
      { name: '心跳后台主动巡查', status: '上线', desc: '每 60 分钟触发（tudigong），22:00~08:00 静默，触发概率 80%。' },
      { name: 'outbound-guard 发送闸门', status: '上线', desc: '拦测试/占位内容 + 拦 120s 内 ≥3 群群发刷版，对所有代理生效。' },
      { name: '迎新自动推播', status: '上线', desc: '新人入群时触发 welcome-party 事件，含自定义底图。' },
      { name: '潜水者发现推播', status: '上线', desc: '潜水成员被发现时触发 lurker-discovered 事件通知。' },
      { name: '课程报名里程碑推播', status: '上线', desc: '课程报名跨 10/25/40/50/60/75/90 人时推播围观群。' },
      { name: '围观群人数里程碑推播', status: '上线', desc: '围观群人数每达 100 整数倍时自动推播。' },
      { name: '市政厅提案决议通知', status: '上线', desc: '市政厅做出决议时手动触发推播运营群。' },
      { name: '点赞狂魔里程碑', status: '上线', desc: '成员一周内点赞达 66 次时，奖励 LP+20 并推播围观群，每人每周一次。' },
      { name: '热门消息自动置顶', status: '上线', desc: '消息获 ≥N 人不同表情反应时自动置顶（阈值由配置驱动）。' },
      { name: 'A2A 暗线广播（代理协作）', status: '上线', desc: '飞书 bot 互不可见，通过 data/peer-bus 暗线信箱传递协作 cue。' },
      { name: '多人多群记忆隔离', status: '上线', desc: '四层命名空间（global / group / user / group_user），严格隔离，A 无法读取 B 的记忆。' },
      { name: 'LP 动态评分', status: '停用', desc: 'LLM 回复后输出 LP_JUDGE 类别按类给分，tudigong 目前停用，改用固定 -0.1。' },
      { name: '跨 App 身份归并', status: '上线', desc: '同一人在不同飞书 App 下的 open_id 归并，LP 跨代理共通。' },
      { name: 'Telegram 运维日志镜像', status: '上线', desc: 'serve 日志单向推送到 Telegram，含日志分级分类及 token 到期提醒。' },
      { name: '点赞封神之路', status: '草案', desc: '六序列/仪轨/动态基数/持榜者设计，方案存于飞书 wiki，待实现。' },
      { name: '文字附件内容读取', status: '上线', desc: 'Bot 被 @ 时可读取同群近 30 分钟内的文字附件（.html / .md / .txt 等）。' },
      { name: '会话自愈（agent-self-heal）', status: '上线', desc: '通过 Skill 运行 pnpm agent doctor --fix 隔离并修复损坏的执行器会话。' },
      { name: '撤回消息', status: '上线', desc: '通过 pnpm agent unsend <message_id> 撤回已发出的飞书消息。' }
    ]
  },

  // Community activity section data — friendly, non-technical snapshots of
  // what the agent keeps track of across the community.
  database: {
    intro: '土地公一直在默默记录城邦里发生的事——谁来了、大家聊了些什么、参加了哪些活动、拿了什么徽章。下面是它正在关注的社区动态。',
    note: '这些是它日常留意的社区动态，还有一些后台记录就不在这儿展开了。',
    tables: [
      { label: '社区群', desc: '土地公在照看的各个社区群，记着每个群的名字和状态。' },
      { label: '群里的聊天', desc: '大家在群里说过的话它都收着，方便日后回顾和搜索。' },
      { label: '群成员名册', desc: '每个群里都有谁、谁来了谁走了，它心里都有本账。' },
      { label: '社区人数变化', desc: '每隔几分钟数一次人头，看看社区是不是又热闹了些。' },
      { label: '成员档案', desc: '每位和它打过交道的伙伴，都有一份小档案，记着积分和等级。' },
      { label: '积分流水', desc: '谁的积分加了、减了、为什么，一笔一笔记得清清楚楚。' },
      { label: '每日签到', desc: '大家每天来打个卡，它就送上一点积分作为鼓励。' },
      { label: '徽章图鉴', desc: '城邦里能拿到的各种徽章，长什么样、代表什么荣誉。' },
      { label: '荣誉墙', desc: '谁拿到了哪些徽章、什么时候拿的，都在这面墙上。' },
      { label: '大事记', desc: '迎新、签到、里程碑……城邦里的大小事它都记一笔。' },
      { label: '活动模板', desc: '各种推播活动长什么样、配什么图、发到哪里，都提前排好。' },
      { label: '推播记录', desc: '每次给大家发的活动通知，发了没、发给了谁，都有据可查。' },
      { label: '活动报名', desc: '未来的活动有多少人报名了，它盯着变化好提醒大家。' },
      { label: '文档热度', desc: '社区的文档谁在看、看了多少，帮大家发现值得读的内容。' },
      { label: '点赞与表情', desc: '大家在消息上点的赞和表情它都收着，用来评选人气王。' },
      { label: '热门置顶', desc: '被很多人点赞的消息，它会自动顶起来，让好内容被看见。' },
      { label: '土地公的记忆', desc: '值得记住的人和事，它会存进记忆里，隔一阵还记得你。' }
    ]
  }
};
