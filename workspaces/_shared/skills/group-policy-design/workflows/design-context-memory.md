# 工作流：规划个人与群组的记忆隔离边界

<required_reading>
**开始前先读：**
1. references/context-model.md（四层命名空间、可见性、Policy Filter、写入归属、字数预算）
2. references/anti-patterns.md（误写全局、把保密寄望于记忆硬闸等）
</required_reading>

<process>
## 第 1 步：列清单——要机器人记住哪些事

跟用户把【希望机器人记得 / 不该记串】的事项列全：哪些是公开知识、哪些跟着某个人走、哪些只在某群内、哪些只关于某群里的某人、哪些只该管理员看到。

## 第 2 步：逐条定命名空间 + 可见性

用 `templates/context-matrix.md` 的【记忆落位计划】表，照 `context-model.md` 的决策树给每条事项定：

```
人人该知道？              → global,                      public
只在这个群内？            → group:{chat},                group / public
跟着这个人走遍所有群？    → user:{open_id},              private
只在这个群、只关于这个人？→ group_user:{chat}:{open_id}, private
敏感、限管理员？          → 对应命名空间,                admin_only
```

写入必带命名空间、绝不图省事落 `global`。

## 第 3 步：填应对矩阵，写出隔离断言

填 `templates/context-matrix.md` 的【应对矩阵】，确认【层级压倒身份】（低密群不会因为来人身份高就泄露高密内容）。写出明确的隔离断言，例如【A 的个人偏好 B 绝对看不到】。

## 第 4 步：离线模拟，验证隔离成立

把规格（groups + memories）写成 `preview_policy.py` 的 JSON，跑：

```bash
python3 scripts/preview_policy.py --spec my-spec.json --chat <chat> --user ou_A --compare ou_B
```

看输出末尾的隔离检查：必须是【✓ 隔离成立：ou_A 看不到 ou_B 的任何私有记忆】。若出现【✗ 越界】，回第 2 步检查是不是把私有内容误落到了共享命名空间。

## 第 5 步：给落点 + 提醒已知限制

交付落位计划 + 写入方式（`agent memory add --namespace … --visibility …`，或说明哪条由自动摘要 / 群组热词沉淀）。**点明 `tier-policy.md` 的已知限制**：个人记忆跨群通用，工作群对话若被自动摘进个人记忆，会在低密群也被注入——这是软约束、非硬隔离。
</process>

<anti_patterns>
- 把本属某人的记忆误写 `global` → 人人可见，隔离被绕过。
- 以为标了群层级，个人记忆就会按层级硬过滤（实际不会）。
- 让会增长的记忆不控长度，超出注入预算被截断。
</anti_patterns>

<success_criteria>
本工作流完成时：
- [ ] 每条要记的事都定了命名空间 + 可见性，无误落 `global`。
- [ ] 应对矩阵体现【层级压倒身份】。
- [ ] 用 `preview_policy.py --compare` 跑出【✓ 隔离成立】作为证据。
- [ ] 给了写入落点，并提醒了个人记忆跨群的软约束边界。
- [ ] 没有直接改库（除非用户明确要求）。
</success_criteria>
