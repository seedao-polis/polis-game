# 配图与 post 消息

<base-image>
## 底图

- 一份**全分辨率原图**放 `workspaces/<soul>/assets/events/<id>/base.png`。给的是链接就先下载存进去。
- 发送时框架自动**等比缩放到 128px 高**（`EVENT_IMAGE_HEIGHT`，聊天里的小缩略图风格）；每事件可用 `imageHeight` 覆盖。原图留底，发送小图自动生成，不用手动准备两份。
- 图的名义比例是 9:25，但渲染按底图**真实像素**算百分比，所以换底图不用改叠字坐标。
</base-image>

<overlays>
## 文字叠加（overlays）—— 百分比定位

`overlays` 是 `TextOverlay[]`；不叠字给 `[]`。每块在底图上画一个矩形（可选背景色）并在里面写字，自动挑能放下的字号。坐标都是 **0–100 的百分比**（相对底图宽/高）：

| 字段 | 必填 | 含义 |
|------|------|------|
| `left` / `top` | 是 | 矩形左上角距左 / 上边缘的百分比 |
| `width` / `height` | 是 | 矩形宽 / 高占图宽 / 高的百分比 |
| `text` | 是 | 文字，可含 `{{date}}` `{{pt}}` 等占位符 |
| `color` | 选填 | 文字颜色，默认白 |
| `bgColor` | 选填 | 矩形背景填充（CSS 颜色，可带 alpha，如 `rgba(0,0,0,.5)`）；省略 = 透明 |
| `bold` | 选填 | 加粗 |
| `align` | 选填 | 水平对齐 `left`/`center`/`right`，默认 `center` |
| `valign` | 选填 | 垂直对齐 `top`/`middle`/`bottom`，默认 `middle` |
| `maxFontPx` | 选填 | 最大字号上限，默认 = 矩形内高 |
| `padding` | 选填 | 内边距百分比，默认 6 |

例（底部居中写日期，半透明黑底白字加粗）：
```ts
overlays: [
  { left: 10, top: 86, width: 80, height: 6, text: '{{date}}',
    bgColor: 'rgba(0,0,0,0.45)', color: '#ffffff', bold: true, align: 'center' },
]
```
中文字体自动注册（mac 上是 PingFang），找不到时回退 sans-serif（拉丁/数字仍可渲染）。
</overlays>

<post-structure>
## 飞书 post 消息结构

一次事件 = 一条 `post` 消息（图 + 标题 + markdown + @ 同在一条）。布局：标题 → 空行 → 图 → 空行 → 正文（空行数由 `gapLines` 控制）。

post content 形如 `{"zh_cn":{"title":"...","content":[[元素],[元素]...]}}`，每个内层数组 = 一行（段落）。元素类型：
| 元素 | 形态 |
|------|------|
| 图 | `{ tag: 'img', image_key: 'img_xxx' }` |
| markdown | `{ tag: 'md', text: '**加粗**' }` |
| 纯文字 | `{ tag: 'text', text: '普通文字' }` |
| @ 提及 | `{ tag: 'at', user_id: 'ou_xxx', user_name: '名字' }` |
| 空行 | `{ tag: 'text', text: '' }` |
</post-structure>

<pitfalls>
## 常见坑

1. **markdown 带不了真正的 @**。要 @ 人必须用 `at` 元素（`{tag:'at',user_id,user_name}`），不能写在 `md` 文本里。
2. **`@` 非目标会话成员会被拒**（230002）→ 框架自动降级成【@名字】纯文本，照常发。
3. **发到群要 bot 先在群里**，否则也报 230002；降级 @ 救不了这个，得先把 bot 拉进群。P2P 无此问题。
4. **图按真实像素算百分比** —— 换底图不必改 `overlays` 坐标。
5. **空行 = 空文字段落**（`{tag:'text',text:''}`），用来在标题/图/正文之间留白。
6. 不确定消息结构时先 `--dry-run` 验证请求 shape，不真发。
</pitfalls>
