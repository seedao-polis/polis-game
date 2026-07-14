# East Money 接口与字段对照

脚本 `scripts/fetch.mjs` 已把这些解析成结构化 JSON，本文件是给人核对/扩展的底层备查。三个接口都是东财网页前端在用的**非公开接口**，无官方契约，字段日后可能变。

## resolve：搜索建议（把名字/代码解析成 secid）

- 主机/路径：`searchapi.eastmoney.com/api/suggest/get`
- 参数：`input=<关键词>&type=14&token=<公开前端 token>&count=<n>`
- token 是东财网页客户端里写死的公开值，不是密钥。
- 回传：`QuotationCodeTable.Data[]`，每条关键字段：

| 字段 | 含义 | 脚本输出键 |
|------|------|-----------|
| QuoteID | 完整 secid（如 `1.600519`） | `secid` |
| Code | 代码 | `code` |
| Name | 名称 | `name` |
| SecurityTypeName | 类型（沪A/港股/美股/指数/债券/板块…） | `type` |
| MarketType | 市场码 | `market` |

## quote：即时报价

- 主机/路径：`push2.eastmoney.com/api/qt/stock/get`
- 参数：`invt=2&fltt=2&secid=<secid>&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170`
- **`fltt=2&invt=2` 时价格字段直接是真实数值，无需再除以 100。**

| 字段 | 含义 | 脚本输出键 |
|------|------|-----------|
| f43 | 最新价 | `price` |
| f46 | 今开 | `open` |
| f44 | 最高 | `high` |
| f45 | 最低 | `low` |
| f60 | 昨收 | `prevClose` |
| f169 | 涨跌额 | `change` |
| f170 | 涨跌幅（%，相对昨收） | `changePct` |
| f47 | 成交量（手） | `volume` |
| f48 | 成交额 | `amount` |
| f57 | 代码 | `code` |
| f58 | 名称 | `name` |

指数类标的的 `volume`/`amount` 可能为 0，属正常。

## kline：日/周/月 K 线

- 主机/路径：`push2his.eastmoney.com/api/qt/stock/kline/get`（**与 quote 不同主机**，可能一个被限流另一个仍可用）
- 参数：`secid=<secid>&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=6`
- 回传 `data.klines` 是逗号分隔字符串数组，顺序固定：

| 位置 | fields2 | 含义 | 脚本输出键 |
|------|---------|------|-----------|
| 0 | f51 | 日期 | `date` |
| 1 | f52 | 开盘 | `open` |
| 2 | f53 | 收盘 | `close` |
| 3 | f54 | 最高 | `high` |
| 4 | f55 | 最低 | `low` |
| 5 | f56 | 成交量 | `volume` |
| 6 | f57 | 成交额 | `amount` |
| 7 | f58 | 振幅（%） | `amplitudePct` |
| 8 | f59 | 涨跌幅（%） | `changePct` |
| 9 | f60 | 涨跌额 | `change` |
| 10 | f61 | 换手率（%） | `turnoverPct` |

- `klt`：`101`=日、`102`=周、`103`=月（脚本默认 101）。
- `fqt`：`0`=不复权、`1`=前复权、`2`=后复权（脚本默认 1）。
- `end=20500101` 取到最新；`lmt=N` 取最近 N 根（脚本第三个参数覆写，默认 6）。
