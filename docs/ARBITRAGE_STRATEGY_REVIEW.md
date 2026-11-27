# gatex 自动套利方案评审与验收建议

2026-11-27 · 评审基线 `423356d` · 供开发团队排期与回复

用户希望指定策略、交易场所、标的和资金预算后，由系统完成开仓、持有、对冲和退出，只在异常时接管。团队提出的资金分配、策略、执行和账户风控四层均有必要。建议把账户手续费、录盘回放和借款监控提前，让第一期就能回答“同一段行情下，哪些机会能覆盖往返成本”。

## 一、实施前需要修正的五个设计点

### 1. 价差开仓要给退出价差定价

对计价单位一致、合约乘数已归一化的线性合约，设 A 所做多、B 所做空，两腿基准资产数量均为 Q。用以下结构比较不同规模的机会，金额统一折算到同一结算单位。

```text
预计往返净收益 = Q × (B 开空均价 − A 开多均价)
               − Q × (B 平空均价 − A 平多均价)
               + 预计持有期资金费净收入
               − 两腿开平四笔手续费 − 借款及其他增量成本
```

例如以同一名义金额折算，开仓价差收入 8 bps、预计退出价差成本 6 bps、手续费共 4 bps，在资金费和借款均为零时，结果是 **−2 bps**。退出报价属于情景估计，需要记录假设。吃单按本批 Q 的可用深度计算 VWAP，深度不足就缩量或拒绝，已包含的盘口冲击只扣一次。挂单按拟挂价格、预计成交量和对冲成本估值，使用该账户、该合约和对应成交角色的费率。[现有开平仓价差计算](../apps/backend/src/strategy-engine.ts#L1353)

### 2. 资金费策略按未来结算事件作决定

开仓时分别枚举两腿在计划持有期内的结算时点，保存当时可见的预测费率、计价基础、方向与数据时间。7 天或 30 天均值、回本天数适合初筛。当预计日净收入小于或等于零时，没有可用的正向回本周期。回放作决策时只能使用当时已发布的数据，事后再以实际结算值或账户流水对账。

提前退出应在同一决策时点比较两条路径：**现在按可成交深度平仓后的净值**，以及**继续持有到下一决策点、计入期间资金费、借款和届时平仓成本后的预计净值**。已付的开仓费、已结算的资金费在两条路径中相同。比较完整路径，可避免把已有浮盈和未来费差直接相比，也能解释为什么一次费率反转后仍值得等一轮。

### 3. 共享保证金要求账户级统一预留

资金预算 C 需要配合风险预算使用，包括策略仓位上限、账户可用保证金缓冲、单腿敞口金额和持续时间上限。风险档位约束最大可下数量，实际切片还受盘口深度、两所共同可行的数量步长以及未决订单影响。建议以账户为单位预留并释放额度，明确部分成交、撤单和重启后的对账规则。

验收时，让两个策略同时申请同一份剩余额度，只允许总量落在账户预算内的订单进入提交。分别记录模型预计占用和账户实际报告值，用于验证资金利用率。[现有保证金预检](../apps/backend/src/trading-runtime.ts#L337) · [CrossEx 账户规则](https://www.gate.com/help/crossex/functional/49325/cross-exchange-account-rules-explained)

### 4. 保护价 IOC、撤单和自动减仓应共享一套故障处理逻辑

优先处理已能从源码定位的场景：Maker 委托仍在场，对冲腿报价失效时，当前挂单维护路径可能在计算不出新报价时直接返回。应冻结新增风险，撤销仍有效的风险挂单，并持续接收成交回报。保护价 IOC 也可能部分成交或零成交，撤单请求之后仍可能收到迟到成交。核对委托、累计成交和实仓后，再决定补腿或减回的方向与数量。[挂单维护](../apps/backend/src/strategy-engine.ts#L1732) · [现有敞口修复](../apps/backend/src/strategy-engine.ts#L2024)

验收时，让一腿部分成交，对冲 IOC 只成交一部分，随后 Maker 在撤单期间又成交。重放后每笔成交只入账一次，补偿量应基于确认后的残余敞口。远端结果未知时保持冻结并报告原因。确认各交易场所支持的订单语义后，再启用对应的保护价与降险路径。

### 5. 先观测借款、保证金和延迟，再决定是否自动调款或改造调度

第一期记录分币种负债、借款成本、初始及维持保证金、告警原因。明确实际账户模式、可用余额、允许划转的路径以及预计偿债效果后，再引入自动再平衡。模拟执行阶段应标注借款和占用的估算来源。

同步记录行情接收、策略判断、请求入队、发出及回报的时间，重点看紧急撤单和对冲请求的排队时长。若瓶颈在 REST 队列，优先为降险与撤单保留容量，并遵守上游总限额。用改造前后的裸腿持续时间评估收益，据此决定是否替换 500 ms 调度或重构请求队列。

## 二、建议的迭代与验收产物

1. **第一期交付录盘与价差模拟的逐笔成绩单。** 选一个在两个目标场所均可交易的标的，记录盘口快照及增量、断流与恢复、价量单位、事件时间和接收时间。同时采集原始资金费率、下一结算时间及费率来源。后台采集应可脱离页面运行。先验证断流后的盘口从有效快照恢复，再持续录制。保留原一档触发，在同一段行情上增加按相同数量、深度和账户手续费估值的双 Taker 版本。两版都用同一成交模型结算，输出逐笔触发与拒绝原因、往返净收益、最大裸腿时间和人工介入次数。没有合格机会就报告零触发；账户费率缺失时列明假设。
2. **第二期交付能少人值守的固定交易对策略。** 接入账户级资金预留、部分成交修复、异常通知、重启对账和独立的资金费模拟策略。常规处置写清适用范围，未决结果达到预设风险限额时告警。验收至少覆盖一次持仓跨结算、一次带未决订单重启和一次迟到成交；给出订单、持仓、资金费和人工处置记录，验证恢复后不会重复开仓。
3. **第三期依结果扩展。** 若主要磨损来自吃单成本，做 Maker 腿选择与挂单退出；若主要来自借款，做负债管理；若固定组合机会不足，再评估换腿轮动和 Spot+Perp。每项扩展说明要降低的成本或风险，并用独立验证期检验改善幅度。

## 三、策略回放与账户资金占用的统计口径

先在相同时段、等价合约、相同资金上限与成交假设下比较策略质量。价差按完整开平往返核算，连续触发的同一机会另行归组。资金费按实际跨过的结算事件计数。期末剩余仓位按相同的可平仓口径估值。保留数据缺口和拒绝记录，避免只统计成功触发的时段。

对每次运行记录账户模式和期初本金，单列净收益、峰值资金占用、因资金不足放弃的机会和人工调拨次数。模拟结果和实际账户观测分别列示。

请团队在本节下方回复首期选用的标的和场所、录盘与回放的验收方式，以及第一份逐笔成绩单将提供的字段。后续可直接附实现提交和样本报告供复审。

## 四、开发团队回复与第一期确认

2026-11-27 · 对应评审基线 `d046c45` · 待复审确认后进入第一期实施

### 1. 对五点设计修正的确认与源码补充

1. **全面采纳评审框架**：同意按「账户费率与深度成本先行、脱离页面后台录盘回放、资金与风险预算统一预留、先观测后扩功能」的三期节奏推进，不在第一期提前堆叠自动调款或换腿轮动。
2. **退出价差口径约定（补充至第 1 点）**：资金费率策略开仓准入按当时双边可成交深度估测保守退出价差成本；短线价差收敛策略（`auto`）开仓准入若直接按同一瞬间对侧平仓定价，会因双边 BBO 点差导致数学上恒负而零触发，因此开仓准入将使用「目标止盈退出价差 + 预期退出深度冲击缓冲」作为情景假设并显式落盘记录，而逐笔成绩单事后结算统一采用实际触发退出时的可成交深度均价（期末未平仓位按可平盘口估值），盘口冲击仅计扣一次。
3. **结算时间轴与盘口断流前置修复（补充至第 2 点与第二.1 节）**：未来结算事件按各所真实整点周期枚举（兼容 Hyperliquid/Lighter 1 小时与 Binance/OKX/Bybit/Gate 等 8 小时/4 小时周期差异）。同时，第一期脱离前端后台录盘前，将一并修补 [market-hub.ts](../apps/backend/src/market-hub.ts#L290) 仅在前端页面订阅时才监听 `order_book_update` 的问题（[FundingOverviewService](../apps/backend/src/funding-overview.ts#L45) 同样需改为独立后台采集），以及 [`applyBookUpdate`](../apps/backend/src/market-hub.ts#L631) 未校验 `U`/`u` 连续性且 WS 重连未清盘重建的问题。
4. **挂单冻结与订单语义核实（补充至第 4 点）**：修补 [`maintainQuote`](../apps/backend/src/strategy-engine.ts#L1732) 在对冲腿行情失效（`desired === null`）时提前返回却未撤销在场 Maker 挂单的漏洞，同时修复 [`evaluate`](../apps/backend/src/strategy-engine.ts#L1408) 与 [`ensureHedged`](../apps/backend/src/strategy-engine.ts#L2024) 在 `repairCooldownMs` 退避冷却期间仍保留并继续补充 Maker 委托的同源问题。正式启用保护价 `IOC` 前，先基于 [`CrossExOrderRequestSchema`](../apps/backend/src/crossex-client.ts#L180) 对各所逐一实测确认 `LIMIT+IOC`/`MARKET+IOC` 与 `reduce_only` 语义。
5. **观测埋点与队列隔离（补充至第 5 点）**：第一期完整记录行情接收、策略判定、入队、出队发网、回包时间戳以及分币种负债、借款成本与保证金占用；同时对照 [`drainAuthenticatedRequestQueue`](../apps/backend/src/crossex-client.ts#L642) 的串行阻塞现状，评估在不突破全局限频的前提下为高优撤单/降险保留独立容量。

### 2. 首期标的和场所

- **首选标的**：`ETH`（流动性与 50 档深度足够支撑 VWAP 滑点验证，合约乘数规范；如样本充足，第二组可扩展对比 `SOL`）。
- **首选场所**：`BINANCE` + `HYPERLIQUID`（并同步旁路采集 `GATE` 资金费作为对照基准）。
- **选择理由**：`BINANCE + HYPERLIQUID` 跨了 CEX 8 小时 USDT 永续与 DEX 1 小时 USDC 永续两种典型账户规则，便于验证跨结算周期对齐与 CrossEx USDT/USDC 负债借款观测。

### 3. 录盘与回放的验收方式

- **独立后台连续录盘**：在不启动/不打开浏览器前端页面的状态下，后台连续采集至少覆盖 **1 个完整 8 小时资金费结算周期**（推荐连续 24 小时），持久化双所 50 档盘口快照与增量（含价量单位、`contract_size` 归一化系数、交易所事件时间 `ts` 与本地接收时间）、原始资金费率、下一结算时间及数据源标识。
- **断流与恢复校验**：在测试或受控回放中至少注入 1 次 WebSocket 断流重连；断流触发时立即将对应盘口状态置为 `BOOK_RESYNCING` 并拒绝一切开平仓触发，校验必须等到重新收到有效 `snapshot` 且连续 `U`/`u` 序号验证通过后才恢复可录和可用状态。
- **同样本双版策略对比回放**：在同一段录制数据、同一成交结算模型、相同总资金与合约归一化口径下，并行运行并输出两份逐笔结果：
  1. **基线版**：保留原一档 BBO 触发逻辑；
  2. **增强版**：按同数量 `Q` 计算 50 档可用深度 VWAP、结合账户实际角色费率（若费率接口缺失则统一回退 VIP 0 并在逐笔记录中显式标注假设）的往返成本过滤双 Taker 版。
- 无合格正净收益机会时如实输出 0 笔触发并保留每轮拒绝原因统计，不裁剪数据缺口与拒绝时段。

### 4. 第一份逐笔成绩单字段定义

每条触发记录及同批次对比摘要按以下字段输出（金额统一折算至同一结算货币 `USDT`）：

| 分组 | 字段名 | 说明 |
|---|---|---|
| **标识与时序** | `run_id`, `strategy_version`, `opportunity_id`, `group_id` | 运行批次、版本（`bbo_v1` / `vwap_taker_v2`）、单次机会 ID 与连续同一机会归组 ID |
| | `asset`, `long_venue`, `short_venue`, `long_symbol`, `short_symbol` | 标的、多空场所与规范化合约标识 |
| | `trigger_ts`, `event_ts_left`, `event_ts_right`, `recv_ts_left`, `recv_ts_right` | 判定时刻、双边数据源事件时间及本地接收时间 |
| **规模、触发与假设** | `decision`, `reject_reason` | `TRIGGERED` / `REJECTED` 及原因（深度不足 / 成本未覆盖 / 费差净收益 ≤ 0 / 盘口失步或超龄） |
| | `budget_usdt`, `planned_qty`, `unit_multiplier_normalized` | 本金预算、计划基准资产数量 `Q` 与合约乘数归一化系数 |
| | `fee_source`, `exit_assumption` | 费率来源（`account_api` / `vip0_fallback`）及本次退出价差情景假设说明 |
| | `bbo_entry_spread_bps`, `vwap_entry_spread_bps`, `est_exit_spread_bps` | 触发时 BBO 价差、按 `Q` 计算的 VWAP 开仓价差及预估退出价差成本 |
| **往返净收益拆解** | `entry_spread_pnl_usd`, `exit_spread_pnl_usd` | 按 `Q` 结算的开仓与退出价差损益（VWAP 冲击不重复扣除） |
| | `fees_4leg_usd` | 两腿开平四笔手续费明细及合计 |
| | `funding_events_crossed`, `funding_net_usd`, `borrowing_cost_est_usd` | 跨过的实际结算事件数、资金费净收入、期间估算借款及其他增量成本 |
| | `roundtrip_net_pnl_usd`, `roundtrip_net_bps` | 完整往返净收益（`USDT` 与折算名义 `bps`） |
| | `is_open_at_end`, `mark_to_close_usd` | 期末是否未平仓及按期末可平盘口深度估值的未实现净值 |
| **延迟与风控观测** | `max_naked_leg_ms`, `rest_queue_wait_ms` | 最大单边裸腿持续时长（模拟/实盘）及 REST 队列排队等待时长 |
| | `margin_used_est_usd`, `margin_used_actual_usd` | 模型预计保证金占用与账户实报（或按规则模拟）占用 |
| | `book_gap_count`, `manual_intervention_count`, `manual_notes` | 盘口失步次数、人工介入次数及处置备注 |

## 五、评审方对第一期方案的回复（2026-11-27）

**同意按第 4 节启动 ETH 在 Binance 与 Hyperliquid 的后台录盘和双 Taker 离线回放。** 接受以目标退出价差加深度缓冲作为开仓情景，事后按退出时可用盘口结算。保留未达到退出条件的持仓和零触发批次。提交 `c90f5c1` 是实施方案，首期验收在收到录盘样本、回放结果和对应代码后进行。

### 录盘实现需要明确的三项约定

1. **重同步期间继续记录，暂停依赖失效盘口的策略判断。** 在 UI 节流、排序和截深之前记录快照、原始增量、连接代次、接收顺序、缺口与恢复事件。新连接的首个有效快照建立基线，按该通道的序号语义处理后续增量。现有解析器允许缺失 `U/u`，盘口更新也没有使用这两个字段。请用两个目标合约各自的样本覆盖快照前增量、重复帧、序号缺口和重连。回放应复现同一失效区间，失效期间仍能查询订单及核对成交。实际深度少于 50 档时保留原样。[盘口解析与更新](../apps/backend/src/market-hub.ts#L631) · [CrossEx 增量盘口协议](https://www.gate.com/docs/developers/crossex/ws/en/#incremental-order-book-subscription)
2. **按数据源确认数量单位，再计算共同的 ETH 数量 Q。** CrossEx 合约目录已将 `contract_size` 标为弃用，并说明统一使用数量。先用两个合约的目录元数据和盘口样本核对价量单位、步长与单档名义金额；已是 ETH 的数量直接使用，避免重复乘系数。每腿保留原始数量、单位和换算结果。[CrossEx 合约目录](https://www.gate.com/docs/developers/crossex/en/)
3. **结算时间按合约读取。** 记录预测值的接收时间、当时公布的下一结算时间，以及之后发布的实际结算记录。周期发生变化或事件缺失时保留原始证据。满足计划录制时长后，还要检查两腿是否各有可关联的真实结算事件。USDC 金额折为 USDT 时，保留汇率来源、时间或平价假设。

### 第一份样本报告如何验收

- **决策和成交可分开重放。** 两版使用相同的数据、延迟假设和成交模型。决策仅使用当时已收到的事件；模拟单按设定到达时刻可用的深度估算成交。逐腿给出数量、均价、费率、手续费和时间，附一次手工可复算的往返或期末估值。若期末盘口失效或深度不足，标明无法完整估值的数量。目标止盈价差只用于事前判断。
- **观测值、假设值及缺失值能区分。** 回退 VIP 0 时记录具体合约、角色、费率数值及来源。只有取得账户实报时才填写 `margin_used_actual_usd`，并注明账户级数值的范围；模拟值填写估算栏。纯离线运行未发生的 REST 排队时长填空，模拟裸腿时长注明所用延迟模型。报告明确净收益 bps 的分母，并分别列出往返已实现损益与期末估值。
- **首轮交付。** 请附实现提交、录盘起止时间、两腿有效盘口的重合时长、一次断流恢复片段，以及可复现的回放命令和摘要。生产订单类型验证单列后续执行阶段；本期以公开行情、只读数据和离线模拟完成验收。

## 六、开发团队协议探测补充与数据采集源决策（2026-11-27）

在正式修改录盘代码前，开发团队于本机显式清除代理直连，对 CrossEx 公开合约目录、CrossEx WS 公共频道以及 Binance / Hyperliquid 官方直连公开行情做了只读报文探测，发现以下需要同步给审计团队的关键事实与调整决定。

### 1. 实测协议事实

1. **合约目录与数量单位确认（`https://api.gateio.ws/api/v4/crossex/rule/symbols`）**
   - `BINANCE_FUTURE_ETH_USDT`：`state = live`，`min_size = 0.001`，`lot_size = 0.001`，`tick_size = 0.01`，`min_notional = 20`，`max_market_size = 2000`，`max_limit_size = 10000`，`contract_size = null`。
   - `HYPERLIQUID_FUTURE_ETH_USDC`：`state = live`，`min_size = 0.0001`，`lot_size = 0.0001`，`tick_size = 0.01`，`min_notional = 10`，`max_market_size = null`，`max_limit_size = null`，`contract_size = null`。
   - 两腿均直接以 `ETH` 为数量单位（不额外乘 `contract_size`），共同可执行步长为 `0.001 ETH`，最小名义门槛取 `20 USD`。

2. **CrossEx WS `order_book_update` 对两目标合约的实际限制**
   - **`BINANCE_FUTURE_ETH_USDT`**（10.5 秒 / 104 帧采样）：`snapshots = 0`，首帧起即推送 `snapshot = false` 的局部增量，从未推送初始 `snapshot = true`；同时 CrossEx 转发时剥离了 Binance 原生用于校验零丢包的 `pu`（`previous_final_update_id`）字段，只保留 `U`/`u`（实测相邻帧 `U - prev_u` 为 `150 / 383 / 218 / 370` 等）。因此仅凭 CrossEx WS 既无法建立 Binance 初始盘口基线，也无法无误报地判定是否存在丢帧缺口；此外对无鉴权 `/crossex/order_book` 探测均返回 `MISSING_REQUIRED_HEADER: Timestamp`，WS `order_book` 频道返回 `Invalid channel`。
   - **`HYPERLIQUID_FUTURE_ETH_USDC`**（10.5 秒 / 2 帧采样）：推送 `snapshot = true`（20 档，`U = u = ts`），但存在约 12 秒级缓存滞后与低频推送（首帧源时间戳滞后接收时间约 `12.7` 秒，两帧间隔约 `12.4` 秒；`funding_rate` 首帧滞后约 `23` 秒），而同连接 `ticker` 在 100ms 级别更新。
   - （对照组 `GATE_FUTURE_ETH_USDT` 与 `OKX_FUTURE_ETH_USDT` 在 CrossEx WS 首帧即推 400 档 `snapshot = true`，增量分别严格满足 `U = prev_u + 1` 与 `U = prev_u`。）

3. **交易所官方直连公开行情实测可用**
   - **Binance Futures 直连**：`GET https://fapi.binance.com/fapi/v1/depth` 提供 `lastUpdateId` 快照；`wss://fstream.binance.com/ws/ethusdt@depth@100ms` 完整推送 `U`、`u` 与 `pu`（实测严格满足 `pu === prev_u`）。
   - **Hyperliquid 直连**：`wss://api.hyperliquid.xyz/ws` 的 `l2Book` 推送 20 档全量深度快照，首帧实测传输滞后约 `571 ms`。
   - **资金费与历史结算接口**：Binance（`premiumIndex` + `fundingRate`）与 Hyperliquid（`metaAndAssetCtxs` + `fundingHistory`）均直连可用。

### 2. 开发团队决定（第一期采集与回放方案）

1. **主盘口采集与重同步以“交易所官方直连（显式禁用代理）”为准**：
   - Binance 腿通过 `REST /fapi/v1/depth` 快照 + `WS depth@100ms` 增量建立本地盘口，严格按 `lastUpdateId` / `U` / `u` / `pu` 校验连续性、快照前缓存、重复帧和断流重建；
   - Hyperliquid 腿通过直连 `WS l2Book` 录制 20 档全量盘口，按时间戳与连接代次管理重连恢复；
   - 所有采集与探测进程显式清除代理环境变量（直连 CEX/DEX），避免本机代理引入额外延迟。
2. **保留 CrossEx WS 作为旁路对照记录**：
   - 同步录制 CrossEx WS 的 `ticker`、`funding_rate` 与原始 `order_book_update` 帧，用于后续定量观测 CrossEx 网关中转延迟，但不作为第一期 Binance 深度建库或序号缺口判定的主数据源。
3. **统一默认口径说明**：
   - `roundtrip_net_bps` 分母统一定义为**单边计划开仓名义价值**（并同步在汇总表列出投入本金预算 `budget_usdt` 对应的收益率参考）；
   - 离线回放同时输出 `0 ms`（信号到达即成交基准）与保守单程延迟假设（如 `100 ms`）结果，模拟裸腿时长明确标注所用延迟模型；
   - Hyperliquid `USDC` 与 Binance `USDT` 之间的资金费/盈亏折算默认记录汇率来源与时间（缺省实时现货汇率时显式标注 `1:1` 平价假设）。

### 3. 请求审计团队确认事项

由于上述第 1、2 项调整将第一期盘口录制主源由“纯 CrossEx WS”变更为“**Binance / Hyperliquid 官方直连为主源 + CrossEx WS 旁路对照**”，请在进入首期编码与长时录盘前确认：

1. **采集源变更确认**：是否同意按上述“官方直连为主盘口（保证 `lastUpdateId + U/u/pu` 序号与低延迟可验证）+ CrossEx WS 旁路记录对照”执行第一期录盘与双版离线回放验收？
2. **口径默认值确认**：是否认可 `roundtrip_net_bps` 以单边计划名义价值为分母，以及离线延迟模型（`0 ms` 基准 + `100 ms` 敏感性对照）的交付形式？

## 七、评审方确认采集源与回放口径（2026-11-27）

已审阅 `38d7185`。**第六节两项请求均同意，团队可以开始编码、试录和长时录盘。** 第一期 ETH 盘口采用 Binance USDⓈ-M 与 Hyperliquid 官方公开数据，CrossEx 的 ticker、资金费和盘口原始帧作旁路观测。BBO 基线版与 VWAP 增强版从同一份原生盘口派生信号，以相同成交模型回放。两版结果均标注为原生场所盘口模拟。现有实盘策略对 CrossEx 报价来源的检查继续适用。[策略报价校验](../apps/backend/src/strategy-engine.ts#L764)

### 采集源与恢复

- **Binance。** 长录使用官方公开深度路由，记录最终订阅的 URL 与流名。先订阅并缓存增量，再取 REST 快照；丢弃结束序号早于快照的帧，首个应用区间须覆盖 `lastUpdateId`。建立基线后核对新帧的 `pu` 与上一个已应用的 `u`。桥接失败、序列中断或重连时立即标记失效，重建期间继续保存原始事件。官方示例当前使用带 `/public/` 的路由，工程配置应核对该路由，勿直接固化短探测使用的地址。[Binance USDⓈ-M 本地盘口规则](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)
- **Hyperliquid。** 每个有效 `l2Book` 快照完整替换该连接代次的 ETH 盘口，记录实际档数、源时间及接收顺序。重连后等待新快照，过期快照不能倒推盘口。20 档内无法覆盖本批 Q 时按已声明规则缩量或拒绝，避免外推不可见深度。[Hyperliquid 快照格式](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
- **旁路与数量。** 第六节的帧数和时差来自团队短时探测。长录报告列出各通道实际覆盖时间、重合有效时长、样本数和报价年龄分布；仅在能匹配同一市场事件时解释两路接收时差。请用原始时间戳澄清 Hyperliquid 所述 10.5 秒采样窗与 12.4 秒帧间隔分别按哪种时钟统计。保持采集进程的直连设置局部生效。共同数量按当期两腿步长取整，并逐腿以对应价格和计价币检查最小名义额；保存当次目录元数据。

### 两个默认值及交付示例

1. **收益分母用单边计划开仓名义价值。** 为使分母唯一，统一以开仓决策时的多腿参考价计算：`planned_notional_usdt = Q_plan × long_ref_price_in_usdt`，记录参考价、取价规则及换汇来源；`roundtrip_net_bps = 10000 × roundtrip_net_pnl_usdt / planned_notional_usdt`。分批往返按同一归组累加相应开仓批次的分母，各批只计一次；部分成交另列实际成交数量与名义额。期末未平部分单列估值。资金预算收益率使用本金作分母，独立展示。
2. **同意 0 ms 和 100 ms 两个单程延迟情景。** 起点是策略使用本地已收到的数据作出决策的时刻，0 ms 使用当时最后一个可用盘口，100 ms 使用同一回放时间轴上截至模拟到达时已收到且有效的盘口。两腿独立取价，缺口内按不可成交处理，禁止用到达时刻之后的快照回填。100 ms 是敏感性参数；实际的 CrossEx 下单延迟与成交质量需由对应执行数据验证。

首次交付请给出一条 Binance 快照桥接与断流恢复记录、一条 Hyperliquid 重连后的首个有效快照，以及同一机会在两个延迟情景下的逐腿计算或拒绝原因。本节确认的是实施口径；短时探测由开发团队执行，长录覆盖率及回放结果待样本提交后复核。

## 八、第一期代码落地、20 秒试录样本与长录前待确认细节（2026-11-27）

开发团队已完成第一期代码模块开发、单元测试以及一次 20 秒真实公开行情试录（含第 8 秒断流重连注入）和离线双版回放验证。

### 1. 已落地代码与校验情况

- **进程内去代理与状态机**：[proxy-free.ts](../apps/backend/src/phase1/proxy-free.ts)、[orderbook-state.ts](../apps/backend/src/phase1/orderbook-state.ts)（`BinanceOrderBookStateMachine` 严格执行缓冲 → REST `lastUpdateId` → `U <= lastUpdateId <= u` 桥接 → `pu === prev_u` 校验；`HyperliquidOrderBookStateMachine` 完整替换 `l2Book` 快照并拒绝倒退时间戳；`walkOrderBookDepth` 严禁外推 20 档之外的不可见深度）。
- **脱离前端的多源录盘器**：[recorder.ts](../apps/backend/src/phase1/recorder.ts)、[record-cli.ts](../apps/backend/src/phase1/record-cli.ts)（CLI：`npm run phase1:record -w apps/backend -- ...`），默认连接 Binance 官方路由 `wss://fstream.binance.com/public/stream?streams=ethusdt@depth@100ms` + `/fapi/v1/depth?symbol=ETHUSDT&limit=1000` 与 Hyperliquid `wss://api.hyperliquid.xyz/ws` `l2Book`，旁路同步录制 CrossEx WS 原始帧（节流与截深前），并周期性采集预测资金费率、实际结算记录及 Gate 现货 `USDC_USDT` 汇率。
- **离线双版回放与成绩单导出**：[replay.ts](../apps/backend/src/phase1/replay.ts)、[replay-cli.ts](../apps/backend/src/phase1/replay-cli.ts)（CLI：`npm run phase1:replay -w apps/backend -- ...`），在同一回放时间轴与成交模型下并行输出 `bbo_v1` vs `vwap_taker_v2` × `0 ms` / `100 ms`，严禁未来数据回填，并将未发生字段（`rest_queue_wait_ms`、`margin_used_actual_usd`）保持为 `null`。
- **单元测试**：[phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts)（覆盖代理剥离、Binance 4 类边界、Hyperliquid 重连与深度上限、以及 `0 ms` vs `100 ms` 缺口失效与净收益精算）；工作区 `lint`、`typecheck` 与全量 `vitest` 测试全部通过。

### 2. 对第七节采样时钟的澄清与 20 秒试录实测摘录

- **对第六节 Hyperliquid 采样时差的澄清**：第六节探测中 CrossEx WS 收到 Hyperliquid `order_book_update` 的第 1 帧源时间戳为 `1795750548695`（本地建连接收时间为 `1795750561447`，网关缓存已滞后约 `12.7s`），第 2 帧源时间戳为 `1795750561119`，`12.4s` 指的是这两帧**交易所源时间戳之差**，而 `10.5s` 指的是脚本本地接收循环总时长（采用本地单调时钟窗口）。
- **20 秒试录样本实测（第 8 秒触发注入断流并自动重连）**：
  - 采集窗口 `2026-11-27T05:56:45.164Z` → `05:57:05.277Z`（`totalWindowMs = 20113 ms`，双腿有效盘口重合 `validOverlapMs = 18878 ms`），共落盘 `1,533` 条事件（含 `bn_depth_delta: 188`、`bn_depth_snapshot: 2`、`hl_l2book: 3`、`cx_raw: 1277`、`funding_settled: 39` 等）。
  - **Binance 桥接恢复**：`connGen=1` 在 `lastUpdateId = 12254734885084` 完成首次桥接（丢弃 1 帧预快照增量，`bidLevels=1012 / askLevels=1003`）；注入断流重连后 `connGen=2` 在 `lastUpdateId = 12254735611573` 自动重新桥接（丢弃 2 帧，`bidLevels=1013 / askLevels=1004`），全程 `sequence_gap = 0`。
  - **Hyperliquid 重连首帧**：`connGen=2` 重连后于 `recvTs = 1795759013920` 捕获首个有效 20 档快照（`sourceTs = 1795759013441`）；但在直连下 `20s` 内 `hl_l2book` 仅推 3 帧（最大间隔接近 `10s`），而旁路 `cx_raw` 显示 CrossEx 对同一 HL `1795759014991` 帧的中转接收时刻相差仅约 `9 ms`（说明 HL `l2Book` 自身在盘口或区块未变化时推送较稀疏）。
  - **双版回放结果（试跑参数 `Q = 0.500 ETH`、`entryBps = 1`、`tpBps = 0`、`VIP0 fallback`）**：`bbo_v1`（`0ms`/`100ms`）各盲目触发 1 笔（`planned_notional_usdt = 870.1`、`fees_4leg_usd = 1.65442`、期末估值 `-1.61568 USDT`）；`vwap_taker_v2` 在 19 个候选时点全部以 `NET_EDGE_NOT_POSITIVE` 拒绝触发（0 亏损），证明了往返成本过滤与只记真实亏损的预期作用。

### 3. 长时录盘（≥ 8 小时）前需审计团队最后确认的三项口径参数

目前代码实现和试录结构已齐备；为避免跑完 8–24 小时完整结算周期样本后再因默认阈值产生返工，请在长录正式验收前确认以下 3 项参数：

1. **Hyperliquid `l2Book` 最大有效报价陈旧时间阈值（`maxBookAgeMs`）**：试录实测直连 `hl_l2book` 推送间隔有时可达数秒至约 10 秒。目前回放默认设 `maxBookAgeMs = 15_000 ms`（超过 15 秒未见新快照即判过期不参与触发与估值）。请确认采用 `15_000 ms` 是否合适，或希望收紧到如 `5_000 ms` / `10_000 ms`（并由此同步定义“有效盘口重合时长”）。
2. **首份长录成绩单的标准测试参数集**：试录默认采用 `Q_plan = 0.500 ETH`、`budget_usdt = 2000`、`assumedLeverage = 5`、`entryBps = 2`（以及试录 `1`）、`takeProfitBps = 0`、`scenarioExitDepthBufferBps = 1`、`cooldownBetweenRejectsMs = 1000`。请确认长录交付按该参数集输出（或指定额外需要多档对比的 `Q_plan` / `entryBps` 档位）。
3. **长录跨结算与断流注入频次**：计划连续后台录制 **8.5–24 小时**（至少完整覆盖 1 次 Binance 8 小时整点结算与多次 Hyperliquid 1 小时整点结算），期间在录制中段人为注入至少 1 次断流恢复片段，连同可复现回放命令、成绩单导出文件和 1 笔手工复算拆解一并提交第一期正式验收。

## 九、第一期代码复审与长录决定（2026-11-27，基线 `7248575`）

**三项实验参数可以定版。正式长录前先修复下述 Binance 跨连接快照竞态并重跑短录；通过后即可启动 8.5–24 小时采集。回放修复可以与采集并行，正式成绩单待复验。** 接受第八节对两个时钟的澄清。团队报告的 20 秒样本适合验证流程，其中的负数是期末模拟平仓估值；增强版没有开仓，这个样本不能据以判断长期收益。提交中没有该次原始 NDJSON，本轮未独立复算其数值。

### 9.1 三项参数答复

| 项目 | 首期约定 |
| --- | --- |
| HL 陈旧阈值 | 同意预先固定 **15,000 ms 为主档，5,000 / 10,000 ms 为敏感性档**，在同一份原始数据上重放。15 秒是研究参数。报告每档双腿同时有效时长、占比、触发数与估值失败数，并注明 Binance 腿的阈值；比较 HL 阈值时固定 Binance 条件。 |
| 规模和门槛 | 同意主表使用 **0.500 ETH、2,000 USDT、5 倍估算杠杆、开仓 2 bps、止盈退出价差 0 bps、退出深度缓冲 1 bps**；1 bps 开仓门槛为辅助表。延迟沿用 0 / 100 ms。明确 2 bps 是 BBO 候选门槛，增强版另按当前默认最低预计净收益 0 bps 过滤。预算仅作收益率分母，杠杆仅作保证金估算。1,000 ms 的拒绝日志节流可保留，原始计数应在节流前累计；区分决策时点、连续机会组和实际模拟开仓数。 |
| 时长和注入 | 同意 **8.5–24 小时，中段注入一次双腿断流**，恢复后继续录制。有条件时取 24 小时。以两个目标合约在录制窗口内实际发布的结算事件为准，核对至少一次 Binance 与多次 HL 结算；启动时补回的历史记录单列。保存注入前、失效期间、重建后的连续原始片段和有效时长。 |

### 9.2 长录启动条件

**采集阻塞项：旧世代的 Binance REST 请求能吞掉新世代唯一的快照请求。** 新连接在打开 250 ms 后取快照，但 `bnResyncInFlight` 在整个录盘器中共享。若旧请求尚未结束，新请求直接返回；随后旧响应因连接代次不符而丢弃，清除标志后没有为新连接补排。独立测试延迟第一代 REST 返回，切换至第二代并触发快照，最后释放旧请求，观察到两代合计只发一次请求、第二代为 `BUFFERING`，且没有待执行的重试。在此状态下增量还会继续写入和缓冲，仅看事件数量无法发现缺少盘口基线。[录盘重同步调度](../apps/backend/src/phase1/recorder.ts#L503)

请按连接代次管理单飞请求或在旧请求完成时可靠唤醒当前代次。验收用延迟响应跨越重连，断言旧结果无效、第二代确实发出 REST 请求并重新桥接；持续建库失败时应能观测并限制缓冲量。随后用独立、空的输出目录做一次短录并核对两腿恢复。当前事件文件以覆盖模式打开，长录也请使用新目录。[输出文件创建](../apps/backend/src/phase1/recorder.ts#L228)

**采集时保全资金费输入。** Binance 的预测周期目前写死为 8 小时，HL 的下一整点由本地时钟推算；按来源标记接口值、推算值和缺失值。保留 Binance 结算记录中的标记价格，以及 HL 结算附近带时间的预言机价和同期 USDC/USDT 汇率。取不到精确结算参考值时保留可追溯的估算依据或标记未知，勿将资金费率、溢价或历史补录条数直接当作本次持仓的现金流。[采集字段](../apps/backend/src/phase1/recorder.ts#L812) · [Hyperliquid 资金费计价规则](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

### 9.3 正式回放报告的修正项

| 项目 | 本轮证据及验收要求 |
| --- | --- |
| 报价年龄与重合时长 | 当前成交过滤只看本地接收时间，重合时长只看同步标志。构造 HL 源时间为 1 ms、接收于 20,002 ms 的帧，阈值 5,000 ms 时仍触发；再经过 20,000 ms 无更新，报告仍计满 20,000 ms 重合。应同时校验源时间和接收时间，对未来时间定义容差；将每条腿到期时刻纳入区间交集。仅单边有数据、空盘口或买卖价交叉也应有明确拒绝原因。当前 CLI 未暴露逐腿年龄参数，请提供可复算三档的命令或配置。[新鲜度和覆盖率](../apps/backend/src/phase1/replay.ts#L521) |
| 延迟成交的因果顺序 | 构造样本末时刻为 20,002 ms、恰在末帧出现机会。100 ms 版本记录了 20,102 ms 的入场成交，又以 20,002 ms 的盘口估值。当前循环也会在信号时立即写入未来的成交状态。请让委托在模拟到达事件后才能改变持仓，录制结束时仍在途的委托单列；测试样本末尾及两个到达时刻之间的连续信号，保证成交时间、持仓与估值顺序一致。[入场到达](../apps/backend/src/phase1/replay.ts#L1047) · [期末估值](../apps/backend/src/phase1/replay.ts#L1279) |
| 结算资金费与原币损益 | 现实现以开仓时多腿参考名义金额计算两所每一次资金费，并用退出时汇率折算 HL 资金费。请按**每腿、每次结算**的参考价格、持仓数量、费率和对应时点汇率计算，标记估算或缺失。另将 HL 永续价差损益先按原币价格差计算，再按明确口径折算；当前逐次换汇后相减会引入整笔名义本金的汇兑损益。独立例中原币盘口不变，仅将期末 USDC/USDT 从 1 改为 1.01，1 ETH 样本期末估值从 −0.2109095 变为 −1.22146405 USDT。区分原币合约损益、费用和实际持有抵押品的汇兑损益。借款成本为零须标注假设。[资金费](../apps/backend/src/phase1/replay.ts#L757) · [期末损益](../apps/backend/src/phase1/replay.ts#L1313) |
| 长文件容量 | CLI 一次读入整份 NDJSON；每条 Binance 增量又生成并常驻一份排序后的完整盘口。在离线样本中，初始买卖各 1,000 档、300 次单档更新，时间线保留 **600,000 条档位记录**。建议顺序读事件，共享当前盘口与有界延迟队列，分段时延续持仓和资金费状态。先给出接近长录事件规模的耗时、峰值内存和跨段结果一致性；20 秒回放成功无法验证长录可处理性。[文件读取](../apps/backend/src/phase1/replay.ts#L239) · [逐帧盘口留存](../apps/backend/src/phase1/replay.ts#L422) |

汇总时请额外列出未能估值的持仓和数量，避免所有未估值行被跳过后显示为零损益。模拟器假设两腿同步全量成交，报告中的裸腿时间 0 ms 仅描述该假设。费用表采用原生场所回退费率时，继续注明与账户实收费率的区别。

**本轮验证。** 独立运行仓库 `vitest run apps/backend/src/phase1/phase1.test.ts`，5 项均通过。上表的边界输入及跨代次测试另行调用提交中的状态机、录盘器快照方法和回放入口完成，没有启动长录。请团队先回复采集修复提交和短录桥接证据，回放修复与逐笔报告随后提交。

## 十、采集竞态修复与跨代次短录实证（2026-11-27）

开发团队已完成第九节第 9.2 节阻塞项修复及资金费输入完整性增强，并已在新空白目录完成 15 秒实盘短录实证。

### 1. 采集修复内容

1. **按连接代次管理 Binance REST 快照请求与中止（[recorder.ts](../apps/backend/src/phase1/recorder.ts#L587)）**
   - 将全局共享的 `bnResyncInFlight` 替换为按连接代次 `connGen` 隔离的 `bnInFlightConnGens` 集合与 `bnAbortControllers` 映射。
   - 连接轮转时对旧代次发出 `AbortController.abort()`（同时保留显式测试延迟注入通道）；即使旧代次请求因底层阻塞而在新连接打开后才延迟返回，新代次 `connGen` 不会被吞掉，旧响应命中 `connGen !== bnConnGen` 时触发 `stale_snapshot_ignored` 记录，且在 `BUFFERING` 兜底检查中绝不遗漏新代次补拉。
2. **有界缓冲与防覆盖保护（[orderbook-state.ts](../apps/backend/src/phase1/orderbook-state.ts#L117)、[recorder.ts](../apps/backend/src/phase1/recorder.ts#L267)）**
   - `BinanceOrderBookStateMachine` 增加默认 `maxBufferLength = 5000` 上限与 `droppedOverflowCount` 计数，超限时触发 `buffer_overflow` 状态记录。
   - `Phase1MarketRecorder.run()` 默认拒绝覆盖已有 `events.ndjson`（除非显式传入 `--overwrite`），确保长录必须使用新目录。
3. **资金费预测周期与结算参考价来源明确化（[types.ts](../apps/backend/src/phase1/types.ts#L171)、[recorder.ts](../apps/backend/src/phase1/recorder.ts#L899)）**
   - 接入 Binance `https://fapi.binance.com/fapi/v1/fundingInfo` 实测 `ETHUSDT` 的 `fundingIntervalHours = 8`，`funding_pred` 显式标明 `intervalSource`（`api_funding_info` / `protocol_hourly_spec` / `missing`）及 `nextFundingTimeSource`（`api_premium_index` / `derived_utc_hour` / `missing`）。
   - `funding_settled` 显式区分 `isHistoricalBackfill`（启动前历史补录 vs 录制期实际结算），并分开保存 Binance `markPrice`、Hyperliquid `premium` 与同期 `nearestOraclePriceUsdc`（含时间）及 `nearestFxUsdcUsdt`（含时间与来源）。

### 2. 单测与 15 秒跨连接延迟快照短录实证

- **单测与工程校验**：[phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts) 扩充至 8 项测试（新增：旧代次 REST 阻塞跨越断流至 `connGen=2` 桥接完成且随后延迟返回触发 `stale_snapshot_ignored`、缓冲溢出有界计数、拒绝覆盖既有目录）；全仓库 `eslint`、`typecheck` 与全量 `vitest` 测试全部通过。
- **空白目录 15 秒实盘短录（`.local-data/phase1/short-race-proof-01`，共 `1,193` 条事件，`validOverlapMs = 13205 ms / 15174 ms`）**：
  - CLI 参数：`--duration-sec 15 --inject-disconnect-sec 1 --inject-delayed-conn1-snapshot-ms 3000 --funding-poll-sec 10`
  - **`connGen=1` 打开与断流**：Binance `connGen=1` 于 `recvTs=1795760832437` 打开并触发延迟快照 #1；于 `1795760833448` 注入断流并在 `1795760833450` 关闭。
  - **新代次独立重同步**：Hyperliquid `connGen=2` 于 `1795760834068` 打开并在 `1795760834123` 收到首个有效 20 档快照（`sourceTs=1795760833585`）；Binance `connGen=2` 于 `1795760834076` 打开、在 `connGen=1` 快照仍挂起期间于 `1795760834339` 独立拉取 REST 快照（`lastUpdateId="12254957123557"`），并于 `1795760834373` 完成 `bridge_ready`（`bidLevels=1013` / `askLevels=1005`，`bestBid="1735.05"` / `bestAsk="1735.06"`）。
  - **延迟旧响应隔离验证**：`1,326 ms` 后的 `recvTs=1795760835699`，`connGen=1` 的延迟快照（`lastUpdateId="12254956976616"`）才返回，系统发出 `bn_book_state: stale_snapshot_ignored`，`connGen=2` 盘口保持完整可用。

### 3. 后续计划

- 开发团队将随即在新输出目录启动 9 小时连续后台长录（覆盖完整 8 小时 Binance 结算周期与多次 Hyperliquid 整点结算，并在中段注入 1 次双腿断流恢复）；
- 长录期间并行完成 **第 9.3 节** 的四项离线回放与报告修正（源/接收时间双校验与 5s/10s/15s 三档命令行复算、严格到达因果与期末在途单列、每腿每次结算原币损益与汇兑损益分离、流式/有界内存长文件回放及近长录规模基准测试），长录结束后提交正式样本报告供复审。

## 十一、评审方确认长录启动条件

已复核 `023634b`。Binance 快照请求现按连接代次隔离，新连接可在旧请求未完成时独立发起快照请求，旧代次返回的结果在应用前会被丢弃。当前实现也加入了缓冲上限、已有文件覆盖保护，以及资金费周期、参考价和历史补录的来源字段。**第 9.2 节的长录启动条件通过复核，已启动的 9 小时录制可以继续。**

独立重跑 `vitest run apps/backend/src/phase1/phase1.test.ts`，8 项通过。开发团队第十节记录的第二代桥接与旧响应丢弃顺序符合代码和回归预期。本轮核对的是团队记录，未取得短录原始 NDJSON 或后台长录状态。

第 9.3 节四项回放与报告修正仍待验收。第十节的重合时长沿用旧实现的同步口径，正式报告请按各档报价年龄重算，并以实际采到的结算记录核对覆盖。交付时附原始样本或可供复核的文件位置、断流片段、回放命令和逐笔结果。
