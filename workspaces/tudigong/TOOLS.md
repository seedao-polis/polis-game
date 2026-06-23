# 工具指南 TOOLS

> 本工作区会用到的工具类别与常用命令速查。详细操作要点都在 `memory/` 对应 playbook，这里只做概览与指路。

## 工具类别总览

| 类别 | 说明 | 典型场景 | 详见 |
|------|------|---------|------|
| 飞书即时通讯 | 收发消息、群成员、表情、撤回、加急 | 主动推播、回应被 @ | `memory/lark-cli-playbook.md` |
| 本地数据库 | 内嵌 SQLite（同步接口），存采集数据与游戏化状态 | 落库、查询、迁移 | `memory/local-db-playbook.md` |
| 智能体执行器 | 框架调用的本地推理 CLI（【大脑】），产生回复 | 回复生成、会话续接 | `memory/agent-executor-playbook.md` |
| 事件 / 推播 | 定时 + 随机触发、发图文到群 / 私聊 | 迎新、活动提醒、里程碑 | `memory/event-system-playbook.md` |
| 运营数据报表 | 取数 → 生成深色图表 → 推送 | 日报 / 月报 | `memory/ops-report-playbook.md` |
| 运维通道 | 日志镜像、令牌到期提醒 | 监控、告警 | `memory/telegram-playbook.md` |

## 常用 CLI 速查（`pnpm agent <子命令>`）

| 命令 | 用途 |
|------|------|
| `serve [soul] [--quiet]` | 启动常驻服务（不带 soul 默认 tudigong）；`--quiet` 只采集不回复 |
| `update [--pull]` | 重新编译并热重启运行中的 serve |
| `cli [soul]` | 本地终端跟 agent 对话（不碰飞书） |
| `doctor [--fix]` | 扫描 / 修复损坏的执行器会话 |
| `events` / `event <id> [--test\|--dry-run]` | 列出 / 手动触发事件 |
| `badge import\|award\|list` | 徽章导入 / 发放 / 查询 |
| `memory list\|preview\|...` | 长期记忆运维（`preview --chat --user` 验证隔离最有用） |
| `report daily\|monthly` | 生成并发送运营数据报告 |
| `calendar-events` / `doc-views` | 查看追踪中的活动报名 / 文档访问记录 |
| `token-check [--test]` | 查看令牌剩余有效期并按需推送提醒 |
| `unsend <message_id>` | 撤回一条已发送的消息 |

## 工具操作要点（精华，细节进 playbook）
- **飞书**：对社区的每条命令都要带正确的应用 profile，否则会被权限拦；便捷命令看 `ok`、原生命令看 `code===0`；发错只能撤回重发（没有编辑）。
- **数据库**：内嵌 SQLite，schema 启动自动迁移；四种【人数】口径别混（详见 `local-db-playbook.md`）。
- **执行器**：会话会【中毒】，排【回复失败】先跑 `doctor`；改了长期记忆要新会话才生效。
- **事件**：手动触发一律 force、不受定时与概率限制；发图按真实像素算百分比。
- **报表**：时间走逻辑日 05:00 起算；自动调度在服务启动时挂，改码要重启服务。

> 工具相关的具体函数、字段、坑位，一律以 `memory/` 对应 playbook 为准。
