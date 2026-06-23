# 群組 Prompt 設定模版（chat-policy-template）

這是一份【填空表】。以後你要為某個飛書群設定 / 調整 tudigong 的 prompt 策略時，
**複製最下面的〈填寫區〉、填好內容貼給我**即可，我會幫你：

1. 在 `configs/chat-policies.json` 新增 / 更新該群的條目
2. 提醒你把群加進該 agent 的 `listen` 清單（否則機器人根本收不到這個群的訊息）
3. 用 `agent memory preview --chat <id> --user <openId>` 幫你驗證實際效果（輸出會顯示群層級）
4. 改完需重建並重啟 serve 才會生效（`chat-policies.json` 在程序啟動時載入並快取）

---

## 三級群組模型

群組依照**營運者手動標記**分為三級，不依賴飛書的內部群/外部群區分：

| 層級 | 說明 | 機器人可說的範圍 |
|------|------|----------------|
| `public`（公開群） | 面向外部觀察者與潛在參與者 | SeeDAO 公開資訊、公開活動、參與方式；**不可**透露會員群、工作群內部事務或未公開決策 |
| `member`（會員群） | 面向 SeeDAO 會員 | 面向會員的事務與活動；**不可**透露工作群的內部運營細節或未公開決策 |
| `work`（工作群） | 面向核心工作成員 | 社區內部運營、治理、協作等各類事務，最開放 |

> 未列入 `chatPolicies` 的群預設為 `public`（最保守），這是 `defaultTier` 的設計。

### 階層保密規則

保密方向是單向向下的：

- 公開群不可透露會員群與工作群的事
- 會員群不可透露工作群的事
- 工作群最高，可討論全部

**保密僅體現在回應上**，由該群的 tier prompt policy 約束機器人語氣與範圍；並非在記憶存取層硬性阻斷（見下方說明）。

---

## 個人記憶跨群通用

`user:{open_id}` 個人記憶**在任何群都會注入**，不分層級。這是設計上的明確決定：

- **跨【群】隔離**：A 的記憶 B 永遠看不到，無論在哪個群（這是程式層強制執行的）
- **跨【層級】隔離**：靠 tier prompt policy 軟性約束，機器人被告知目前在哪種群、什麼話可說；而不是在記憶層硬性過濾

已知限制：若在工作群中累積的對話被自動摘要寫入個人記憶，那段摘要理論上可能在低層級群中被注入。目前依營運者決定，純靠 prompt policy 約束（軟性保證），未做記憶分級硬閘控。

---

## `systemPromptAppend` 寫作原則

每個群可選填 `systemPromptAppend`，這段文字會**疊加在 tier policy 之後**進入 system prompt。

- **不要重複 tier policy 的內容**：tier policy 已自動注入，這段只寫【跟同層級其他群不同的規則】。
- 開頭點明情境：【你現在在〈群名〉……】讓機器人知道自己在哪。
- 順序建議：**受眾 → 可以講 → 不可以講 → 語氣**。
- **不要重複人格**：土地神 persona 已在 soul（`workspaces/tudigong/`）裡，這段只寫群專屬規則。
- **控制長度**：每次該群對話都會帶上這段，建議 ≤ 100 字。
- 可留空不填（`systemPromptAppend` 是選填欄位）。

---

## 內建 Tier Policy 文字（預設，可在 `tierPolicies` 覆寫）

**public**
```
你现在所在的是公开群，面向外部观察者与潜在参与者。可以介绍 SeeDAO 的公开信息、公开活动与参与方式；不要透露会员群、工作群的内部事务、未公开决策或成员私人信息。语气友善、简洁、偏公开传播。
```

**member**
```
你现在所在的是会员群，面向 SeeDAO 会员。可以讨论面向会员的事务与活动；但不要透露工作群的内部运营细节或未公开决策。语气亲切、具体。
```

**work**
```
你现在所在的是工作群，面向核心工作成员。可以讨论社区内部运营、治理、协作等各类事务。
```

---

## 我會產出的條目長這樣（`configs/chat-policies.json`）

```json
"oc_xxxxxxxxxxxxxxxx": {
  "name": "示例群",
  "tier": "public",
  "systemPromptAppend": "你現在在示例群，主要面向對 SeeDAO 感興趣的外部觀察者。"
}
```

---

## 兩個現成種子（目前已設定）

**public（圍觀群）**
```json
"oc_example_public_group": {
  "name": "围观群",
  "tier": "public"
}
```

**work（運營小天地）**
```json
"oc_example_ops_group": {
  "name": "运营小天地",
  "tier": "work"
}
```

---

## 設定後怎麼驗證

```bash
# 看某人在這個群會拿到哪些記憶與群層級
agent memory preview --chat oc_xxx --user ou_xxx
# 輸出包含一行：群层级：public / member / work

# 查看實際寫進該 (群,人) session 的 system prompt（含 tier policy 與群專屬補充）
cat .agent/tudigong/chats/tudigong-bot-oc_xxx-ou_xxx/.kimi-code/AGENTS.md
```

---

## 〈填寫區〉— 複製這段、填好貼給我

```
群名稱：
chat_id：              # oc_ 開頭；不知道就描述這個群（名稱 / 用途），我幫你查
群層級：               # public（公開群）/ member（會員群）/ work（工作群）—— 見上方三級說明
受眾是誰：             # 例：外部觀察者 / SeeDAO 會員 / 核心工作成員……
systemPromptAppend（選填）：
                       # 疊加在 tier policy 之後的群專屬補充；可留空（tier policy 已自動注入）
已加入 listen 了嗎：   # 是 / 否 / 不確定（不確定我幫你看 configs/agents.json）
```
