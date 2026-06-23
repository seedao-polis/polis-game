# Workflow: 触发 / 验收事件

<required_reading>
**先读这些：**
1. references/commands.md（命令与 flags、验收顺序）
2. references/event-model.md（force、skipped、@ 降级语义）
</required_reading>

<objective>
安全地预览、验收、最终触发一个事件；发错了能撤回。事件触发是**服务端操作员命令**，只在 server 端跑。
</objective>

<process>
## 第 1 步：dry-run 预览

```
agent event <编号|id> --dry-run
```
不发送、不发 LP、不写库。看 `prepare` 选了谁、标题/正文长啥样、哪些 @ 会被降级成文本。看到【已跳过】= `prepare` 判定本次无需发送（不是错误）；个人事件记得带 `--actor <ou_>`。

## 第 2 步：test 验收（只发给自己）

```
agent event <编号|id> --test
```
把目标强制改成操作者本人 P2P，真发但不打扰真实群/别人。肉眼确认排版、底图、@（不在你 P2P 的 @ 会降级成文本，正常）。可叠 `--dry-run`。

## 第 3 步：真发

确认无误后：
```
agent event <编号|id>
```
- 发到**群**前先确认 bot 已在目标群，否则报 230002。
- 也可不手动发，让排程到点自动触发（手动一律 force，不受定时/概率限制）。
- 成功后会打印 `message_id` 和现成的撤回命令。

## 第 4 步：需要时撤回

```
agent unsend <message_id> [--as bot|user]
```
事件是 bot 发的，默认身份 bot。

## 安全档位
- 没明确要真发时，停在 `--dry-run` / `--test`，不擅自发到真实目标。
- 个人事件用 `--actor` 指定对象；要改目标用 `--to`（`--test` 优先级更高）。
</process>

<success_criteria>
- [ ] 先 `--dry-run` 看过选人与文案。
- [ ] 用 `--test` 发给自己肉眼验收过排版/图。
- [ ] 真发前确认了目标（群则 bot 在群、单一目标正确）。
- [ ] 知道用 `agent unsend <message_id>` 撤回。
- [ ] 没有越权真发。
</success_criteria>
