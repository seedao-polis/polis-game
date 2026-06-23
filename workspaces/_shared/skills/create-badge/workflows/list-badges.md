# Workflow: 查询徽章

<required_reading>
**先读这些：**
1. references/commands.md
</required_reading>

<process>
## 第 1 步：判断查什么

- 查【有哪些徽章定义】 → 无参数。
- 查【某人持有哪些徽章】 → 带该成员的名称或 `ou_xxx`。

## 第 2 步：运行

全部定义：
```
agent badge list
```

某成员持有：
```
agent badge list <名称或 ou_xxx>
```
名称同名多人时改用 `ou_xxx`。

## 第 3 步：回报

把结果整理给用户。若用户接着要发某枚，转 award-badge.md；要新增，转 import-badge.md。
</process>

<success_criteria>
- [ ] 选对了【全部定义】还是【某成员持有】。
- [ ] 运行了对应命令并把结果回报用户。
</success_criteria>
