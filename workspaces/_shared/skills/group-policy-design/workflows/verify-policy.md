# 工作流：验证隔离与策略是否真的生效

<required_reading>
**开始前先读：**
1. references/apply-in-code.md（CLI、生效流程、本地验证环）
</required_reading>

<process>
## 第 1 步：离线模拟（不碰任何库）

先用模拟器把预期跑出来——开箱即跑，无需配置：

```bash
# 内置示例：管理员能看到 admin_only，普通人看不到
python3 scripts/preview_policy.py --chat oc_work --user ou_admin --admin
python3 scripts/preview_policy.py --chat oc_work --user ou_A

# 内置示例：证明 A 看不到 B
python3 scripts/preview_policy.py --chat oc_pub --user ou_A --compare ou_B
```

确认：①【群层级】与预期一致；②管理员视角才出现 `admin_only` 记忆；③ `--compare` 末尾打印【✓ 隔离成立】。要验证自己的策略就传 `--spec my-spec.json`。

## 第 2 步：实测隔离（临时库，不碰生产）

指向一个临时库，造两个人的私有记忆，亲眼看隔离：

```bash
export AGENT_DB_PATH=/tmp/policy-test.db
agent memory add --namespace user:ou_A --content "A 的秘密" --visibility private
agent memory add --namespace user:ou_B --content "B 的秘密" --visibility private
agent memory preview --chat oc_X --user ou_A   # 应只见 A 的
agent memory preview --chat oc_X --user ou_B   # 应只见 B 的——B 读不到 A
```

`agent memory preview` 的输出会带【群层级】【可读命名空间】【注入记忆】三类信息，逐项核对。

## 第 3 步：核对分级政策与群层级

对目标群的真实 chat_id 跑：

```bash
agent memory preview --chat <真实 chat_id> --user <某 open_id>
```

确认【群层级】一行 = 你在 `chat-policies.json` 标的层级。层级错了，多半是没重启（配置缓存）或群没进 `chat-policies.json`（落到了 defaultTier）。

## 第 4 步：核对管理员门控

```bash
agent memory preview --chat <c> --user <管理员 open_id>            # 应见 admin_only
agent memory preview --chat <c> --user <非管理员 open_id>          # 不应见 admin_only
agent memory preview --chat <c> --user <非管理员 open_id> --admin  # 强制管理员视角，应见
```

## 第 5 步：若有改配置，确认已生效

改过 `chat-policies.json` / `agents.json` / `admins.json` 的话：确认已**重建 + 重启 serve**；分级 / 专属提示类改动还要重开已存在的会话。没重启就预览，会看到旧值。
</process>

<anti_patterns>
- 直接在生产库上造测试记忆（应先 `export AGENT_DB_PATH` 指向临时库）。
- 看到层级不对就改代码，其实只是没重启让缓存失效。
- 只跑单人预览，不做 `--compare` / 双人对照，漏掉跨人泄漏。
</anti_patterns>

<success_criteria>
本工作流完成时：
- [ ] 离线模拟器跑出【✓ 隔离成立】与预期层级。
- [ ] 临时库实测：B 读不到 A 的私有记忆。
- [ ] 目标群【群层级】与配置一致。
- [ ] 管理员门控核对过（admin_only 仅管理员可见）。
- [ ] 涉及配置改动的，已确认【重建 + 重启】。
</success_criteria>
