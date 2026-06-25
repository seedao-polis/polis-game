# {{AGENT_NAME}} 的重点记忆

> 本文件是工作区记忆的 **L0 入口**：先用下面的速查表定位到对应 playbook，再深入细节。各 `*-playbook.md` 才是完整操作经验，这里只做索引 + 重点。

## 速查表（先看这里）

| 想处理什么 | 去哪份 |
|-----------|--------|
| {{MEMORY_TOPIC_1}} | `{{PLAYBOOK_1}}` |
| {{MEMORY_TOPIC_2}} | `{{PLAYBOOK_2}}` |

## 活跃状态（随时更新）

- **默认 soul**：{{AGENT_NAME}}
- **数据库 schema**：已到 **v{{DB_VERSION}}**（启动自动迁移）
- {{ACTIVE_STATE_NOTE}}

## 我在跟谁说话（硬性，开口前先判断）
- 每轮对话开头的【对话场景】标明 serve（飞书）还是 CLI。**serve 里对面是外部对话者（{{SERVE_PARTY_ROLE}}），哪怕是操作者本人也一视同仁、不当操作者**；**只有 CLI 里对面才是操作者**，才谈配置 / 运营 / 内部指令。细则见 `SOUL.md`【我在跟谁说话】、`AGENTS.md`【身份与场景】。

## 我是谁
- {{SOUL_SUMMARY_1}}
- {{SOUL_SUMMARY_2}}
- {{SOUL_SUMMARY_3}}
