# 城邦土地神 · Agent 档案页面

本目录包含 **tudigong Agent 个人档案**的静态页面，可部署到 GitHub Pages，无需任何构建步骤。

---

## 快速预览

直接用浏览器打开 `index.html` 即可（`file://` 协议可正常工作，因为数据在 `data.js` 而非 `fetch`）。

---

## 如何开启 GitHub Pages

1. 进入仓库 **Settings → Pages**
2. Source 选择 **Deploy from a branch**
3. Branch 选 `docs`，文件夹选 `/docs`（本页面位于 docs/ 子目录）
4. 保存后等待几分钟，GitHub 会给出访问地址，形如 `https://seedao-polis.github.io/polis-game/`

---

## 如何替换 Google 表单地址

页面中的「许愿 / 提建议」按钮需要连接一个 Google 表单。步骤：

1. 在 Google Forms 创建一个表单，添加「您在哪个区块提建议？」之类的单行字段
2. 打开表单的预填链接，在 URL 中找到该字段的 `entry.XXXXXXXXXX` 参数编号
3. 打开 `data.js`，找到顶部的 `config` 对象，替换两个占位值：

```js
config: {
  googleFormBase: 'https://docs.google.com/forms/d/e/你的表单ID/viewform',
  googleFormEntrySection: 'entry.你的字段ID',
  ...
}
```

替换后保存并推送，按钮即可直接跳转到预填了区块名称的表单。

> 在替换前，点击按钮会弹出一个提示框说明「表单尚未配置」，不会跳转到无效链接。

---

## 如何维护页面数据

**所有展示内容均在 `data.js` 中**，以 `window.PROFILE_DATA` 对象的形式存储，按区块分组：

| 字段路径 | 说明 |
|---------|------|
| `hero.*` | 头像、名称、简介、状态徽章 |
| `permissions.identity` | bot / user 双身份说明 |
| `permissions.groupTiers` | 监听群三级分类 |
| `permissions.mcpTools` | MCP 工具列表（11 个） |
| `permissions.outboundGuard` | 安全闸门说明 |
| `permissions.limits` | 能力边界数值 |
| `database.tables` | 17 张社区数据表（名称、所属库、说明、关键字段） |
| `skills.exclusive` | 专属技能 |
| `skills.shared` | 共用技能（7 个） |
| `skills.abilities` | 现有玩法与能力（28 项），含状态标注 |

修改 `data.js` 后，重新加载页面即可看到更新。

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.html` | 主页面，引入 Tailwind CDN、Google Fonts，定义四大区块骨架 |
| `style.css` | 玻璃卡片、渐变文字、动效等 Tailwind 不易表达的自定义样式 |
| `app.js` | 纯 vanilla JS，从 PROFILE_DATA 渲染各区块，处理许愿表单跳转 |
| `data.js` | 所有页面数据，以 `window.PROFILE_DATA = {...}` 形式存储 |
| `README.md` | 本文件 |
