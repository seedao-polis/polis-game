# 群策略填空表（group-policy-spec）

复制下面〈填写区〉、填好，就能产出一个群的策略方案。每一格都对应 `apply-in-code.md` 里的一个落点。

---

## 〈填写区〉

```
群名称：
chat_id：              # oc_ 开头；不知道就描述这个群（名称 / 用途），由助手帮你查
群层级：               # public（公开群）/ member（会员群）/ work（工作群）—— 见 tier-policy.md
受众是谁：             # 例：外部观察者 / 正式会员 / 核心工作成员……
可以讲：               # 这个群机器人应该主动讲、乐于回答的内容
不可以讲：             # 这个群机器人必须回避、不得透露的内容（注意单向向下保密）
语气：                 # 例：友善简洁 / 亲切具体 / 直接专业
systemPromptAppend（选填）：
                       # 叠在分级政策之后的群专属补充；≤100 字；只写本群独有规则
                       # 不重复分级政策、不重复人格；可留空
已加入 listen 了吗：   # 是 / 否 / 不确定（不确定就去看 configs/agents.json 的 listen）
```

---

## 产出物（助手据填写区生成）

**1. `configs/chat-policies.json` 的群条目**

```json
"oc_xxxxxxxxxxxxxxxx": {
  "name": "<群名称>",
  "tier": "<层级>",
  "systemPromptAppend": "<群专属提示，或省略此字段>"
}
```

**2. listen 提醒**

确认 `configs/agents.json` 里对应智能体的 `listen` 包含此 `chat_id`；否则机器人收不到该群消息。

**3. 验证命令**

```
agent memory preview --chat <chat_id> --user <某个 open_id>
# 看【群层级】一行是否为预期层级；看注入记忆是否符合该群该人应有的范围
```

**4. 生效提醒**

改完 `chat-policies.json` → 重建 + 重启 serve；已存在的会话重开后才带上新系统提示。

---

## 检查清单（交付前自查）

- [ ] 层级选定，且【可讲 / 不可讲】符合单向向下保密（低密群不讲高密群的事）。
- [ ] `systemPromptAppend` 只写本群独有规则，不重复分级政策、不重复人格，≤100 字（或留空）。
- [ ] 已确认 `listen` 包含该群。
- [ ] 给了验证命令与【重建 + 重启】提醒。
- [ ] 没有直接改配置 / 改库（除非用户明确要求）。
