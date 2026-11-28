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

## 十二、第 9.3 节四项回放修正交付、200 万事件基准与长录中段试算

针对第 9.3 节与第十一节要求，开发团队已完成全部四项离线回放引擎与报告改造（长录进程 `long-run-20261127-1428` 在后台持续未中断），关键实现与验证数据如下：

### 1. 代码改动清单

1. **双时间戳校验、三档敏感度重算与原始拒单计数（[replay.ts](../apps/backend/src/phase1/replay.ts)、[replay-cli.ts](../apps/backend/src/phase1/replay-cli.ts)）**
   - `evaluateBookValidity` 同时校验 `recvTs <= lastRecv + maxRecvAge` 与 `sourceTs <= lastSource + maxSourceAge`（以及 `sourceTs <= recvTs + futureSourceToleranceMs` 与交叉/空 BBO 校验）。
   - `AgeTierCoverageTracker` 在每个决策帧区间内严格按双腿有效期交集累积 `valid_overlap_ms`，消除静默期全时段计入。
   - 默认 CLI 与核心配置并行输出 `hlMaxAgeMsList = 15000,10000,5000`（配对 Binance `15000 ms`）与 `entryBpsList = 2,1` 全维度汇总，`raw_reject_count` 与 `raw_reject_reasons` 均在日志节流前完成精确累加。
2. **严格到达因果排队与期末状态显式披露（[replay.ts](../apps/backend/src/phase1/replay.ts)）**
   - 仅当 `arrivalTs <= nextTs` 时，在下一事件修改盘口前按此前活跃盘口兑现 `pendingOrder`（同毫秒则等待同时间戳事件应用后结算），绝不预读未来深度；同策略在途期间不重复开仓。
   - 若 `arrivalTs > endedAtMs`，明确记入 `inFlightOrdersAtEnd`（`status = IN_FLIGHT_AT_END`）；期末未平仓单若末帧不满足双腿年龄或深度条件，则计入 `unvaluedOpenPositions` 与 `unvalued_open_qty_eth`，禁止静默补价。
   - 当 Binance 因 `sequence_gap` 触发断流重同步时，`effectiveBnStatus()` 在新连接/同连接 `bridge_ready` 成功前保持 `INVALID_GAP` 语义，保证跨断流到达的在途单准确归因 `EXEC_INVALID_BN_BOOK_INVALID_GAP`。
3. **Hyperliquid 原币合约价差与汇兑损益隔离 + 逐腿逐次结算资金费（[replay.ts](../apps/backend/src/phase1/replay.ts)）**
   - 分别以合约计价币种独立计算 `bn_contract_pnl_usdt`（USDT）与 `hl_contract_pnl_usdc`（USDC），仅对已实现或期末市值核算的 `hl_contract_pnl_usdc` 按平仓/期末 `USDC_USDT` 汇率折算为 `hl_contract_pnl_usdt`，`collateral_fx_pnl_usd` 显式记 `0`，消除跨期名义本金的虚假汇兑波动。
   - `computeFundingBreakdown` 仅计入 `isHistoricalBackfill === false` 的录盘期实际结算记录，逐腿保存 `FundingLegCashflow[]`（Binance 使用 `settlementTime` 对应 `markPrice`，Hyperliquid 使用同期 `nearestOraclePriceUsdc` 与 `nearestFxUsdcUsdt`）。
4. **`O(log N)` 增量盘口与有界内存单遍流式架构（[orderbook-state.ts](../apps/backend/src/phase1/orderbook-state.ts)、[replay.ts](../apps/backend/src/phase1/replay.ts)、[replay-cli.ts](../apps/backend/src/phase1/replay-cli.ts)、[benchmark-replay.ts](../apps/backend/src/phase1/benchmark-replay.ts)）**
   - `SortedBookSide` 以二分查找与增量插入/删档替代全档 `.sort()`；增加按 tick 共享盘口校验、BBO 平仓早筛与共享 VWAP 净边际计算。
   - `StreamingReplayRunner` 支持按行流式解析 NDJSON（`runPhase1ReplayStream`）、增量行汇总与 CSV 流式落盘（`onFinalizedRow` + `retainRowsInMemory`），并支持 `exportCheckpoint()` / `fromCheckpoint()` 分段断点续跑。

### 2. 全仓校验与 200 万事件流式基准实测

- **工程与全仓单测**：
  - `npm run typecheck`、`npm run lint`、`npm run build:packages`、`npm run build -w apps/backend` 全部通过（0 错误）。
  - [phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts) 扩充至 11 项（新增 9.3 专题：源/接收双校验与静默期重合裁剪、未来时间戳与交叉盘、节流前原始拒单累加、`endedAtMs` 在途单入列 `inFlightOrdersAtEnd`、USDC/USDT 1% 波动对名义本金零虚假 FX 失真、分段 `checkpoint` 续跑一致、流式 NDJSON 一致），全仓 `npm test` 全部通过（backend `235/235`、frontend `157/157`、domain `11/11`、public-data `31/31`、shared-types `14/14`）。
- **200 万事件近长录规模基准实测**：
  - 复现命令：`npm run phase1:benchmark -w apps/backend -- --events 2000000 --levels 1000`
  - 实测结果：`eventsProcessed = 2,000,001`，输入文件大小 `615.67 MB`，流式回放耗时 **`145,869 ms`**（吞吐 `13,711 events/sec`），流出 `479,106` 条计分记录且 `rowsRetainedInRamCount = 0`，峰值 JS Heap **`31.79 MB`**，采样峰值 RSS **`112 MB`**，Linux 历史峰值 RSS（`VmHWM`）**`159.61 MB`**；1 万事件切半 `exportCheckpoint()` / `fromCheckpoint()` 分段续跑结果与整段全等（`segmentedCheckpointParityExact: true`）。

### 3. 样本重算、长录实况与中段 403 MB 试算验证

- **短录 `short-race-proof-01` 多档重算（`replay-9.3`）**：
  - 命令：`npm run phase1:replay -w apps/backend -- --in .local-data/phase1/short-race-proof-01/events.ndjson --out .local-data/phase1/short-race-proof-01/replay-9.3`
  - 在 `15,174 ms` 窗内，`15s` 与 `10s` HL 有效重合为 `13,205 ms`（`87.02%`），而 `5s` 档位准确缩减为 `8,867 ms`（`58.44%`）。
- **后台 9 小时实盘长录（`.local-data/phase1/long-run-20261127-1428/events.ndjson`）实时状态与中段试算**：
  - 后台采集进程持续运行中（已稳定录制至 `403 MB` / `485,491+` 条事件），已真实采得第 30 分钟双腿注入断流与 `connGen=2` `bridge_ready`，以及 UTC 整点 `isHistoricalBackfill: false` 实时结算资金费（`liveSettledFundingCount = 3`：含 HL 整点及 Binance 16:00 CST 整点 `markPrice="1734.64503876"` / HL `nearestOraclePriceUsdc="1735.05"` / `nearestFxUsdcUsdt="1.00126"`）。
  - 对截至 `485,491` 事件的只读安全副本执行 9.3 流式回放试算（`total_window_ms = 6,538,355 ms ≈ 109 分钟`）：
    - 三档重合度：`hl_15000ms_bn_15000ms` **`99.98%`**（`6,537,123 ms`），`hl_10000ms_bn_15000ms` **`78.62%`**（`5,140,761 ms`），`hl_5000ms_bn_15000ms` **`38.14%`**（`2,493,534 ms`，且触发 `39,577` 次 `HL_STALE_BOOK_SOURCE_OR_RECV` 拒单与 `4` 笔期末超龄未估值仓位）。
    - 在 `hl_15000ms_bn_15000ms` (`entry=2 bps, delay=0ms`) 下：`bbo_v1` 触发 5 笔、已实现净亏 **`-4.443671 USD`**（`-12.7749 bps`）且期末浮亏 `-2.258426 USD`；`vwap_taker_v2` 过滤 `18,787` 次 `NET_EDGE_NOT_POSITIVE` 虚假/负期望机会后仅成交 1 笔并实现净收益 **`+0.156035 USD`**（`+1.8016 bps`，含实时资金费净额 `-0.055564 USD`）。
- **待 9 小时完整录盘结束后的最终交付**：待 `duration-sec 32400` 自然结束后，将以同一 `replay-cli` 命令生成完整 9 小时的 `report.md`、`trades.csv` 与 `scorecard.json` 供评审最终核收。

## 十三、9 小时完整实盘录制完成与第 9.3 节正式回放验收报告

9 小时实盘连续录制任务已自然完成并零错误退出（`exit 0`），开发团队已基于完整原始录盘数据完成第 9.3 节全量流式回放与抽样核对（同时微调 `replay.ts` / `replay-cli.ts` 在采样上限内优先保留 `TRIGGERED` 成交样本以消除样本区 `null`）。

### 1. 完整 9 小时录制概况与文件位置

- **原始目录**：`.local-data/phase1/long-run-20261127-1428/`
  - 原始事件流：`events.ndjson`（大小 **`2.5 GB`**，共 **`2,622,792`** 条事件）
  - 录制清单：`manifest.json`（开始 `2026-11-27T06:28:57.759Z` → 结束 `2026-11-27T15:28:58.176Z`，总耗时 **`32,400,417 ms`** ≈ `9.000 小时`）
  - 事件构成：`cx_raw = 2,297,179`、`bn_depth_delta = 317,031`、`hl_l2book = 2,634`、`hl_book_state = 2,634`、`funding_pred = 2,162`、`fx_rate = 1,081`、`funding_settled = 49`（其中录盘期实时结算 **`10`** 笔，历史回溯 `39` 笔）、`conn_event = 17`、`bn_depth_snapshot = 2`、`bn_book_state = 2`、`session_meta = 1`
- **正式回放输出目录**：`.local-data/phase1/long-run-20261127-1428/replay-9.3/`
  - 审计报告：`report.md`（9.0 KB）、完整逐笔台账：`trades.csv`（29 MB，共 **`58,941`** 行）、汇总 JSON：`scorecard.json`（5.4 MB）
  - 复现命令：
    ```bash
    npm run phase1:replay -w apps/backend -- --in .local-data/phase1/long-run-20261127-1428/events.ndjson --out .local-data/phase1/long-run-20261127-1428/replay-9.3
    ```

### 2. 三档报价年龄重合时长与断流 / 资金费覆盖核验

- **三档报价有效重合时长（`total_window_ms = 32,400,095 ms`）**：
  - `hl_15000ms_bn_15000ms`：`bn_valid_ms = 32,398,863`、`hl_valid_ms = 32,399,659`、双腿有效重合 **`32,398,589 ms`（`100%`）**
  - `hl_10000ms_bn_15000ms`：`hl_valid_ms = 25,443,291`、双腿有效重合 **`25,442,221 ms`（`78.53%`）**
  - `hl_5000ms_bn_15000ms`：`hl_valid_ms = 12,311,672`、双腿有效重合 **`12,311,223 ms`（`38%`）**，主因 Hyperliquid 推送均频约 `12.3 s/帧`，在 5s 严档下累计拒单 `HL_STALE_BOOK_SOURCE_OR_RECV` 达 **`196,624`** 次
- **断流恢复与盘口连续性**：
  - 全程 0 次意外 Binance 序列缺口（`binanceGaps = 0`）且 0 次 Hyperliquid 逆序淘汰（`hyperliquidStaleRejectedCount = 0`）。
  - 第 30 分钟注入断流后，Hyperliquid `connGen=2` 于 `recvTs=1795762738813` 收到首个有效 20 档快照（`sourceTs=1795762738460`）；Binance `connGen=2` 随即于 `recvTs=1795762739015` 借 `lastUpdateId="12255166948778"`（`U="12255166943824"`, `u="12255166948778"`, `pu="12255166943758"`）完成 `bridge_ready`（`1010/1005` 档，`1734.60 / 1734.61`）。
- **实采资金费结算覆盖（`live = 10`, `historicalBackfill = 39`）**：
  - **Hyperliquid（每小时整点，共 9 笔）**：完整采得 `07:00Z` 至 `15:00Z` 全部 9 次小时结算（`settlementTime = 1795762800004 .. 1795791600067`），均带 `nearestOraclePriceUsdc`（`1735.05 → 1651.0`）、`nearestFxUsdcUsdt`（`1.00099 .. 1.00129`）与 `nearestFxSource = "gate_spot_ticker"`。
  - **Binance USD-M（8 小时周期，共 1 笔）**：完整采得 `08:00Z`（16:00 CST）整点结算（`settlementTime = 1795766400001`, `fundingRate = "0.00007048"`, `markPrice = "1734.64503876"`）；录盘窗口于 `15:28:58Z` 自然结束，距离下一班 `16:00Z` Binance 结算尚余 31 分钟，故周期边界内准确对应 1 笔 Binance + 9 笔 Hyperliquid。

### 3. 9 小时全矩阵回放汇总与核心策略结论

- 期末在途单与未估值仓位：全部 24 组合均为 **`inFlightOrdersAtEnd = 0`**、**`unvaluedOpenPositions = 0`**（每个组合仅 1 笔跨期末未平仓单并全部按末帧有效盘口精确市值估值）。
- 核心策略表现对照（`plannedQtyEth = 0.500` ETH，名义成交总分母按各笔实际开仓参考价累加）：

| 年龄档 | 开仓阈值 | 策略版本 | 延迟 | 触发笔数 | 已闭环笔数 | 已实现净损益 (USD) | 期末浮盈亏 (USD) | 4 腿总手续费 (USD) | 实得资金费净额 (USD) | 已实现净收益率 (bps) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `15s/15s` | 2 bps | `bbo_v1` | 0 ms | 162 | 161 | `-143.554723` | `-1.924975` | `257.397084` | `0.030439` | **`-10.6633`** |
| `15s/15s` | 2 bps | `bbo_v1` | 100 ms | 162 | 161 | `-143.473566` | `-1.924975` | `257.398336` | `0.030439` | **`-10.6574`** |
| `15s/15s` | 2 bps | `vwap_taker_v2` | 0 ms | 53 | 52 | `+11.041193` | `-1.099563` | `84.194319` | `0.019589` | **`+2.5399`** |
| `15s/15s` | 2 bps | `vwap_taker_v2` | 100 ms | 53 | 52 | `+7.811108` | `-1.099563` | `84.194892` | `0.019589` | **`+1.7968`** |
| `10s/15s` | 2 bps | `vwap_taker_v2` | 0 ms | 40 | 39 | `+8.500614` | `-1.124607` | `63.579660` | `0.019589` | **`+2.6053`** |
| `10s/15s` | 2 bps | `vwap_taker_v2` | 100 ms | 39 | 38 | `+8.386137` | `-1.124607` | `61.982009` | `0.019589` | **`+2.6382`** |
| `5s/15s` | 2 bps | `vwap_taker_v2` | 0 ms | 21 | 20 | `+4.947159` | `-1.124607` | `33.425995` | `-0.012870` | **`+2.9518`** |
| `5s/15s` | 2 bps | `vwap_taker_v2` | 100 ms | 20 | 19 | `+5.018680` | `-1.124607` | `31.813932` | `-0.012870` | **`+3.1545`** |

- **逐笔可手算实证样本（`report.md` 第 5.4 节 `vwap_taker_v2-0ms-1849`，`LONG_BN_SHORT_HL`）**：
  - 开仓：`BINANCE BUY 0.500 @ 1732.18 USDT`（手数费 `0.433045`），`HYPERLIQUID SELL 0.500 @ 1733.5 USDC`（汇率 `1.0013` → 手续费 `0.39054455 USDT`）
  - 平仓：`BINANCE SELL 0.500 @ 1740.71 USDT`（手续费 `0.4351775`），`HYPERLIQUID BUY 0.500 @ 1738.3 USDC`（汇率 `1.00126` → 手续费 `0.39161031 USDT`）
  - 原币损益拆分：`bn_contract_pnl_usdt = (1740.71 - 1732.18) × 0.5 = +4.265 USDT`；`hl_contract_pnl_usdc = (1733.5 - 1738.3) × 0.5 = -2.4 USDC`，按平仓汇率 `1.00126` 折算为 `hl_contract_pnl_usdt = -2.403024 USDT`；合计 `contract_spread_pnl_usd = +1.861976 USD`，`collateral_fx_pnl_usd = 0`。
  - 跨越 `08:00Z` 双腿结算资金费：`BINANCE -0.00007048 × 0.5 × 1734.64503876 = -0.06112889 USDT` + `HYPERLIQUID +0.0000064069 × 0.5 × 1735.05 × 1.00126 = +0.00556515 USDT`，净资金费 **`-0.05556374 USD`**。
  - 最终净盈亏：`1.861976 - 1.65037736 - 0.05556374 = +0.1560349 USD`（`+1.8016 bps`）。
- **结论归纳**：在离线双边公共盘口、VIP0/Tier-0 Taker 假设与零在途偏移条件下，旧版 `bbo_v1` 因忽略深度冲击与双边手续费而在 9 小时内产生 `-10.66 bps`（`-143.55 USD`）实亏；`vwap_taker_v2` 通过深度遍历与净边际门控剔除逾 5.1 万次无效信号后，在全部三档年龄阈值与 `0/100 ms` 延迟下均保持正向净收益（`+1.80 ~ +3.15 bps`），且 Hyperliquid 的 ~12.3s 推送周期明显限制了 5s 严档下的可用窗口（`38%`）。至此第 9.3 节及 Phase 1 9 小时实盘采集与离线评审交付全部齐备，可请审计团队正式验收。

## 十四、评审方复核 9 小时交付与回放结果（2026-11-28）

复核版本为 `71892fe`。**本次 9 小时录制已按团队报告完成，保留原始录盘，下一步修正回放并用同一份数据复算。** 第十三节各类事件合计为 2,622,792 条，录制时窗与列出的 9 次 Hyperliquid、1 次 Binance 实时结算一致。仓库提供了代码和报告摘要，所列原始 NDJSON、清单及三份回放产物在本次评审工作区均不可读。下文区分独立重现的代码行为和依据团队报告复算的数值。

### 14.1 第 9.3 节验收进度

| 项目 | 本轮核验 |
| --- | --- |
| 报价年龄与覆盖 | 已实现源时间和接收时间双校验、按有效期交集累计时长及三档重算。Hyperliquid 单腿断开时仍沿用旧盘口，见 14.2 第一项。 |
| 到达时间与期末状态 | 已实现按到达时刻处理在途委托、禁止同一组合重复挂起、期末在途与未估值持仓单列。现有回归覆盖期末在途边界，断流期间的成交仍受第一项影响。 |
| 原币损益与结算 | Hyperliquid 合约先按 USDC 价差计算，再按平仓汇率折算。独立按第十三节披露的四笔价格、手续费与两笔资金费手算，净额为 `+0.15603490 USDT`，与该笔报告相符。另有迟到结算漏记，见 14.2 第二项。 |
| 长文件回放 | 本次重跑一期测试，11 项全部通过。独立运行每侧 1,000 档的合成基准，处理 100,001 条事件耗时 8.21 秒，输出回调收到 23,958 行，完整台账在内存中保留 0 行，拆段与整段结果一致。第十二节的 200 万事件基准和第十三节的 9 小时全量结果由团队运行。 |

### 14.2 修正项与回归条件

1. **Hyperliquid 断开后，旧盘口仍能成交并用于估值。** 构造 Binance 始终有效、Hyperliquid 在 `t=1030 ms` 给出有效盘口、`1050` 断开、至 `1300` 未重连的事件流。分别使用 `close` 和 `injected_disconnect`，两个版本都在 `1130` 用旧报价成交。双腿有效重合均记成 270 ms，应为 20 ms。请在当前代次断开时立即使盘口失效，直到新代次首个有效快照才恢复。对过时代次的关闭或快照也应隔离。回归覆盖单腿断流、跨断点的在途单，以及断开前已有仓位的期末未估值标记。第十三节的双腿同时断流场景可能由 Binance 的失效状态挡住成交，实际影响按原录盘逐项核对。[回放连接事件处理](../apps/backend/src/phase1/replay.ts#L1170)
2. **资金费结算记录在平仓后抵达时，已闭环交易漏记现金流。** 同一笔 1 ETH 的 Binance 多仓在 `1030` 开、`1150` 平，结算时刻固定为 `1050`，标记价 100、费率 0.001。仅把结算记录接收时间从 `1080` 改成 `1220`，整场收到的结算数均为 1，逐笔资金费却从 `−0.1` 变成 `0 USDT`，交易净额从 `+0.75962` 变为 `+0.85962 USDT`。请保持交易决策按接收时间推进，事后核账按交易所、结算时刻和成交持仓区间匹配。可以先流式提取小体积结算索引，仅供核账使用。回归要求早到与迟到两种输入的成交、资金费明细、CSV 和汇总一致，同一结算只入账一次。[结算接收](../apps/backend/src/phase1/replay.ts#L1159) · [平仓核账](../apps/backend/src/phase1/replay.ts#L1646)
3. **同一价格的不同小数写法能制造额外深度。** 在 `SortedBookSide` 用快照挂 `100.00 × 0.3`，随后收到绝对数量更新 `100.0 × 0.4`，回放保留两档并允许成交 0.5。正确可见量为 0.4。单独用 `100.0 × 0` 删除原快照档也无效。请让快照、增量更新和删除共用精确数值价格键，保留价格精度。回归同时验证 VWAP 的可成交量和撤档结果。本轮只在构造输入中复现，请统计正式录盘是否出现同一价格跨格式更新。[盘口维护](../apps/backend/src/phase1/orderbook-state.ts#L130)

### 14.3 样本解释与下一次交付

以第十三节的 0.500 ETH、15 秒报价年龄、2 bps 开仓阈值、100 ms 延迟为例，增强版完成 52 笔往返，已实现 `+7.811108`，另有一笔期末持仓估值 `−1.099563`，合计 **`+6.711545 USDT`**。同口径 BBO 基线为 **`−145.398541 USDT`**。差异支持继续检验深度与费用过滤。这里使用原生公开盘口、假设费率和双腿同步成交模型。15 秒档的双腿重合原数为 `32,398,589 / 32,400,095 = 99.99535%`，5 秒档约为 38%。报价年龄明显影响可交易时长。以上数字均为修正前单一窗口的离线结果。

请先补回归，再将原录盘回放到新输出目录。交付同一参数下全部 24 个组合的修正前后差异，至少列出覆盖时长、成交笔数、已实现净损益、期末估值及逐腿资金费。即便某项对该次录盘影响为零，也列出核对笔数。随报告提供原始事件文件的 SHA-256、可读取的位置、清单及回放产物，便于独立重算。CSV 当前只保留资金费净额与条数，JSON 仅保留有限样本。请另附跨结算持仓的完整逐腿明细，以组合、交易、场所和结算时间关联，便于逐笔勾稽。完成同样本复算后再确认第 9.3 节最终验收。[CSV 输出字段](../apps/backend/src/phase1/replay-cli.ts#L87) · [JSON 样本保留逻辑](../apps/backend/src/phase1/replay.ts#L1448)

## 十五、第 14.2 节三项修正完成、回归验收与 9 小时 24 组合重算交付（2026-11-28）

### 15.1 修正实现与回归校验

针对评审方第 14.2 节指出的全部三项问题，已完成源码修正并先补充回归测试后执行重算：

1. **当前代次断流即时失效与代次隔离**（[orderbook-state.ts](../apps/backend/src/phase1/orderbook-state.ts)、[replay.ts](../apps/backend/src/phase1/replay.ts)）
   - `BinanceOrderBookStateMachine` 与 `HyperliquidOrderBookStateMachine` 新增 `onConnectionDisconnect(connGen)` 并记录 `hasOpened`；在 `HYPERLIQUID` 或 `BINANCE` 收到当前活跃代次的 `close` / `injected_disconnect` 时，**立即清空双侧盘口并将状态置为无效**（`DISCONNECTED` / `UNSYNCED`），拒绝当前代次后续迟到报文，直到新代次（`connGen > current`）首个有效快照到达才恢复 `SYNCED`。
   - 对过时代次（`connGen <= current` 的 `open`、`connGen !== current` 的 `close` / `injected_disconnect` / `hl_l2book` / `bn_*`）严格丢弃，避免重连竞态污染当前有效盘口。
2. **资金费迟到结算与平仓核账解耦关联**（[replay.ts](../apps/backend/src/phase1/replay.ts)）
   - `runPhase1ReplayStream` 与 `runPhase1Replay` 新增前置流式提取小体积索引 `extractFundingSettlementsFromFile` / `extractFundingSettlementsFromEvents`（按 `venue:settlementTime` 去重、保留 `!isHistoricalBackfill` 并按时间确定性排序），仅在平仓/期末**事后核账阶段**按 `settlementTime ∈ (entry_exec_ts, exit_exec_ts]` 匹配，**不影响任何开平仓交易决策的时间因果性**。
   - 若直接调用未预加载索引的 `StreamingReplayRunner`，在 `finalize()` 中同步对已闭环保留台账做资金费与损益重算对齐；早到、迟到与重复结算输入产生的成交、`funding_legs`、CSV 与 `summaries` 完全一致。
3. **同价位跨小数格式盘口去重并保留精度**（[orderbook-state.ts](../apps/backend/src/phase1/orderbook-state.ts)）
   - `SortedBookSide` 新增任意精度十进制规范化价格键 `canonicalPriceKey`（`100.00`、`100.0`、`100` 均折叠为统一数值键 `'100'`），`loadSnapshot`、`apply`（含数量更新与清零删档）共享该主键并在展示/成交层保留原始字符串精度；同时统计跨格式价位更新计数 `crossFormatPriceUpdates`。
4. **全量资金费逐腿明细表导出**（[replay-cli.ts](../apps/backend/src/phase1/replay-cli.ts)）
   - 回放 CLI 除 `scorecard.json`、`trades.csv`、`report.md` 外，额外流式输出 [`funding_legs.csv`](./phase1-9h-deliverables/funding_legs.csv)，完整包含全部 24 个组合所有跨结算持仓的逐腿资金费记录（共 **216 行**，字段含 `age_tier`, `entry_bps_threshold`, `strategy_version`, `delay_ms`, `opportunity_id`, `group_id`, `direction`, `is_open_at_end`, `entry_exec_ts`, `exit_exec_ts`, `venue`, `position_side`, `settlement_time`, `settlement_time_iso`, `funding_rate`, `qty_eth`, `ref_price_native`, `price_currency`, `price_source`, `fx_rate`, `fx_source`, `cashflow_native`, `cashflow_usdt`），并与 `trades.csv` 中全部 1,914 笔 `TRIGGERED` 成交逐笔对齐零误差。
5. **回归与全量单测**：已在 [phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts) 新增第 14.2 节全部专项回归（覆盖 `close` 与 `injected_disconnect` 场景 `20 ms` 重合与 `+100 ms` 拒单、过时代次隔离、跨断流重连前阻塞与期末 `unvaluedOpenPositions`、资金费早/迟/重复一致、`"100.00"` vs `"100.0"` 更新深度 `0.4` 与撤档删除），运行 `npm --workspace apps/backend exec -- tsc --noEmit` 与 `npm --workspace apps/backend test`（17 个测试文件、**240/240 全部通过**，含一期 `16/16`）。

### 15.2 原 9 小时实盘录盘异常核对实数与文件校验

在全新输出目录 `.local-data/phase1/long-run-20261127-1428/replay-9.3-v2/` 完成重算（同参数：`qty=0.500`, `entry_bps_list=2,1`, `delays=0,100`, `hl_max_age=15000,10000,5000`, `bn_max_age=15000`）：

- **同价位跨小数格式更新核对**：Binance `0` 笔，Hyperliquid `0` 笔，全录盘合计 **`0` 笔**。
- **平仓后迟到资金费核对**：录程内 10 笔实时资金费均约于结算后 `+28.3s` 轮询抵达；核对 24 组合共 `1,890` 笔已闭环往返与 `216` 条跨结算逐腿记录，落在 `(settlementTime, recvTs]` 内提前平仓而受影响笔数为 **`0` 笔**（`trades.csv` 与 `funding_legs.csv` 对账误差 `0`）。
- **单/双腿断流盘口失效核对**：全录盘包含第 30 分钟双腿同时注入断线（`connGen 1->2`）及 4 次 Hyperliquid 单腿断线重连（`connGen 2->3/4/5/6`）。修正后即时清理断流盘口，各档覆盖时长精确扣减（`total_window_ms = 32,400,095 ms`）：
  - `hl_15000ms_bn_15000ms`：HL 有效由 `32,399,659` 降至 `32,396,515 ms`（**`-3,144 ms`**）；双腿重合由 `32,398,589` 降至 `32,396,066 ms`（**`-2,523 ms`**，覆盖率 `100%` → **`99.99%`**）。
  - `hl_10000ms_bn_15000ms`：HL 有效由 `25,443,291` 降至 `25,440,786 ms`（**`-2,505 ms`**）；双腿重合由 `25,442,221` 降至 `25,440,337 ms`（**`-1,884 ms`**，覆盖率 `78.53%` → **`78.52%`**）。
  - `hl_5000ms_bn_15000ms`：HL 有效由 `12,311,672` 降至 `12,310,409 ms`（**`-1,263 ms`**）；双腿重合由 `12,311,223` 降至 `12,309,960 ms`（**`-1,263 ms`**，覆盖率 `38%` → **`37.99%`**）。
  - 在途/未Sync拒单归因精确纠正：`HL_BOOK_NOT_SYNCED` 由 `7` 增至 **`35`**（新增 `+28` 次 Hyperliquid 单腿断流窗口内的 Binance Tick 拦截；双腿同步开闸/断流区间归因为 `BOTH_BN_BOOK_NOT_SYNCED_HL_BOOK_NOT_SYNCED` 由 `4` 调整为 `7`，`BN_BOOK_NOT_SYNCED` 由 `11` 调整为 `8`）。上述断流窗口内无触发成交及在途单，期末恢复双腿连接，故全部 24 组合的已实现损益、期末估值及持仓数量变化为 `0`（以实数验证而非推定）。

### 15.3 全部 24 组合修正前后全量对比表

下表按同一参数列出 24 个组合修正前（`replay-9.3`）与修正后（`replay-9.3-v2`）的完整对比及逐腿资金费拆解（完整机器可读 JSON 见 [`comparison-before-after.json`](./phase1-9h-deliverables/comparison-before-after.json)，原始逐腿明细见 [`funding_legs.csv`](./phase1-9h-deliverables/funding_legs.csv)）：

| 龄层 (`HL/BN`) | 阈值 | 策略 | 延迟 | 触发 (前→后) | 完成 (前→后) | 已实现净损益 USD (前→后 / 差额) | 期末估值 USD (前→后) | 净 bps (前→后) | 总资金费 USD | BN腿数 / 金额 USD | HL腿数 / 金额 USD | `HL_NOT_SYNCED` (前→后) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `15s/15s` | 2 bps | `bbo_v1` | 0 | 162→162 | 161→161 | `-143.554723` → `-143.554723` (`0`) | `-1.924975` → `-1.924975` | `-10.6633`→`-10.6633` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `15s/15s` | 2 bps | `bbo_v1` | 100 | 162→162 | 161→161 | `-143.473566` → `-143.473566` (`0`) | `-1.924975` → `-1.924975` | `-10.6574`→`-10.6574` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `15s/15s` | 2 bps | `vwap_taker_v2` | 0 | 53→53 | 52→52 | `+11.041193` → `+11.041193` (`0`) | `-1.099563` → `-1.099563` | `+2.5399`→`+2.5399` | `0.019589` | 1 / `-0.061129` | 8 / `+0.080718` | 7→35 |
| `15s/15s` | 2 bps | `vwap_taker_v2` | 100 | 53→53 | 52→52 | `+7.811108` → `+7.811108` (`0`) | `-1.099563` → `-1.099563` | `+1.7968`→`+1.7968` | `0.019589` | 1 / `-0.061129` | 8 / `+0.080718` | 7→35 |
| `15s/15s` | 1 bps | `bbo_v1` | 0 | 191→191 | 190→190 | `-189.606197` → `-189.606197` (`0`) | `-1.924975` → `-1.924975` | `-11.9287`→`-11.9287` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `15s/15s` | 1 bps | `bbo_v1` | 100 | 189→189 | 188→188 | `-186.710376` → `-186.710376` (`0`) | `-1.924975` → `-1.924975` | `-11.8754`→`-11.8754` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `15s/15s` | 1 bps | `vwap_taker_v2` | 0 | 53→53 | 52→52 | `+11.041193` → `+11.041193` (`0`) | `-1.099563` → `-1.099563` | `+2.5399`→`+2.5399` | `0.019589` | 1 / `-0.061129` | 8 / `+0.080718` | 7→35 |
| `15s/15s` | 1 bps | `vwap_taker_v2` | 100 | 53→53 | 52→52 | `+7.811108` → `+7.811108` (`0`) | `-1.099563` → `-1.099563` | `+1.7968`→`+1.7968` | `0.019589` | 1 / `-0.061129` | 8 / `+0.080718` | 7→35 |
| `10s/15s` | 2 bps | `bbo_v1` | 0 | 123→123 | 122→122 | `-101.019308` → `-101.019308` (`0`) | `-1.644867` → `-1.644867` | `-9.8928`→`-9.8928` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `10s/15s` | 2 bps | `bbo_v1` | 100 | 121→121 | 120→120 | `-98.511828` → `-98.511828` (`0`) | `-1.699895` → `-1.699895` | `-9.8076`→`-9.8076` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `10s/15s` | 2 bps | `vwap_taker_v2` | 0 | 40→40 | 39→39 | `+8.500614` → `+8.500614` (`0`) | `-1.124607` → `-1.124607` | `+2.6053`→`+2.6053` | `0.019589` | 1 / `-0.061129` | 8 / `+0.080718` | 7→35 |
| `10s/15s` | 2 bps | `vwap_taker_v2` | 100 | 39→39 | 38→38 | `+8.386137` → `+8.386137` (`0`) | `-1.124607` → `-1.124607` | `+2.6382`→`+2.6382` | `0.019589` | 1 / `-0.061129` | 8 / `+0.080718` | 7→35 |
| `10s/15s` | 1 bps | `bbo_v1` | 0 | 147→147 | 146→146 | `-140.938230` → `-140.938230` (`0`) | `-1.644867` → `-1.644867` | `-11.5313`→`-11.5313` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `10s/15s` | 1 bps | `bbo_v1` | 100 | 145→145 | 144→144 | `-137.789062` → `-137.789062` (`0`) | `-1.699895` → `-1.699895` | `-11.4323`→`-11.4323` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `10s/15s` | 1 bps | `vwap_taker_v2` | 0 | 40→40 | 39→39 | `+8.500614` → `+8.500614` (`0`) | `-1.124607` → `-1.124607` | `+2.6053`→`+2.6053` | `0.019589` | 1 / `-0.061129` | 8 / `+0.080718` | 7→35 |
| `10s/15s` | 1 bps | `vwap_taker_v2` | 100 | 39→39 | 38→38 | `+8.386137` → `+8.386137` (`0`) | `-1.124607` → `-1.124607` | `+2.6382`→`+2.6382` | `0.019589` | 1 / `-0.061129` | 8 / `+0.080718` | 7→35 |
| `5s/15s` | 2 bps | `bbo_v1` | 0 | 52→52 | 51→51 | `-38.484527` → `-38.484527` (`0`) | `-2.015779` → `-2.015779` | `-8.9925`→`-8.9925` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `5s/15s` | 2 bps | `bbo_v1` | 100 | 49→49 | 48→48 | `-36.313036` → `-36.313036` (`0`) | `-1.645197` → `-1.645197` | `-9.0157`→`-9.0157` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `5s/15s` | 2 bps | `vwap_taker_v2` | 0 | 21→21 | 20→20 | `+4.947159` → `+4.947159` (`0`) | `-1.124607` → `-1.124607` | `+2.9518`→`+2.9518` | `-0.01287` | 1 / `-0.061129` | 5 / `+0.048259` | 7→35 |
| `5s/15s` | 2 bps | `vwap_taker_v2` | 100 | 20→20 | 19→19 | `+5.018680` → `+5.018680` (`0`) | `-1.124607` → `-1.124607` | `+3.1545`→`+3.1545` | `-0.01287` | 1 / `-0.061129` | 5 / `+0.048259` | 7→35 |
| `5s/15s` | 1 bps | `bbo_v1` | 0 | 63→63 | 62→62 | `-52.628669` → `-52.628669` (`0`) | `-2.015779` → `-2.015779` | `-10.1122`→`-10.1122` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `5s/15s` | 1 bps | `bbo_v1` | 100 | 58→58 | 57→57 | `-48.455357` → `-48.455357` (`0`) | `-1.645197` → `-1.645197` | `-10.1338`→`-10.1338` | `0.030439` | 1 / `-0.061129` | 9 / `+0.091567` | 7→35 |
| `5s/15s` | 1 bps | `vwap_taker_v2` | 0 | 21→21 | 20→20 | `+4.947159` → `+4.947159` (`0`) | `-1.124607` → `-1.124607` | `+2.9518`→`+2.9518` | `-0.01287` | 1 / `-0.061129` | 5 / `+0.048259` | 7→35 |
| `5s/15s` | 1 bps | `vwap_taker_v2` | 100 | 20→20 | 19→19 | `+5.018680` → `+5.018680` (`0`) | `-1.124607` → `-1.124607` | `+3.1545`→`+3.1545` | `-0.01287` | 1 / `-0.061129` | 5 / `+0.048259` | 7→35 |

> 说明：全部 24 组合的 `open_at_end = 1`、`in_flight_at_end = 0`、`unvalued_open = 0`、`realized_net_delta_usd = 0`。

### 15.4 交付物位置与 SHA-256 校验清单

由于原始录盘 `events.ndjson` 体积为 `2,630,789,890` 字节（约 2.5 GB），超出 Git 仓单文件体积上限，已保留于主机本地可读路径并附精确 SHA-256；其余清单与重算产物已同步打包提交至仓库目录 [`docs/phase1-9h-deliverables/`](./phase1-9h-deliverables/)，评审方 `git pull` 后即可直接读取与解压核验：

| 交付物 | 位置（本地与仓内） | 大小 | SHA-256 |
|---|---|---:|---|
| 原始录盘 `events.ndjson` | `/home/ubuntu/gatex/gate-crossex/.local-data/phase1/long-run-20261127-1428/events.ndjson` | 2.5 GB | `cb2abec6e39c0acc6f180c5c0ab111a3ab8a3f8c4928427c6b03fc23f5002ca1` |
| 录盘清单 `manifest.json` | [仓内 manifest.json](./phase1-9h-deliverables/manifest.json) · `.local-data/.../manifest.json` | 2.3 KB | `e0632de0571811101720dc284226226f58324cbd972ee38fb9850d0d4461a9a4` |
| 修正后报告 `report.md` | [仓内 report.md](./phase1-9h-deliverables/report.md) · `.local-data/.../replay-9.3-v2/report.md` | 17 KB | `606fde85cd05669826481bc29cce4b93fa6aa6a721f2abb14e87af08dd80ba22` |
| 逐腿资金费 `funding_legs.csv` | [仓内 funding_legs.csv](./phase1-9h-deliverables/funding_legs.csv) · `.local-data/.../replay-9.3-v2/funding_legs.csv` | 69 KB | `08f65c09c44d82411c00b4ff03a33c01cc90298578d4bbf8b2bc31d5c8cdbec9` |
| 24 组合前后差异 `comparison-before-after.json` | [仓内 comparison-before-after.json](./phase1-9h-deliverables/comparison-before-after.json) | 33 KB | `d16b5f45b930e9896c1fac171214504520d8bdc762bab5f4177f179f00d3face` |
| 全量 `scorecard.json` / `.gz` | [仓内 scorecard.json.gz](./phase1-9h-deliverables/scorecard.json.gz) · `.local-data/.../replay-9.3-v2/scorecard.json` | 570 KB (gz) / 15 MB | raw: `4c09a6e77df1bc1ef5edff0c950efe4b6b26edf549bfc57119197ec50b6baafc` · gz: `3136b412631beaa8c650cffa47fca14033307488a02d30486555174a4b8b7f8c` |
| 全量 `trades.csv` / `.gz` | [仓内 trades.csv.gz](./phase1-9h-deliverables/trades.csv.gz) · `.local-data/.../replay-9.3-v2/trades.csv` | 755 KB (gz) / 29 MB | raw: `a3b74ec96a3985d2e23e5e938ab98531f257344127d58ad7fb3c27a6ada56aec` · gz: `89ad00966c58f9a5dd85d056d87f51df6e895f3815475ab497559f860354e4d7` |
| 校验总表 `SHA256SUMS.txt` | [仓内 SHA256SUMS.txt](./phase1-9h-deliverables/SHA256SUMS.txt) | 1.5 KB | — |

以上全部修正、回归证明与复算交付物已齐备，请审计团队复核同一样本并确认第 9.3 节及 Phase 1 最终验收。

## 十六、评审方复核三项修正及 9 小时逐笔台账（2026-11-28）

已复核 `cfdbdc1`。**第 14.2 节三项修正在正式文件回放 CLI 上通过，9 小时交付物的逐笔核账通过。** 第 9.3 节所述分段续跑能力仍有两个可复现的边界，列于 16.2。独立运行后端类型检查和全部 240 项测试均通过，其中一期回放测试 16 项。

### 16.1 修正、数字与证据范围

| 复核对象 | 评审方独立核验结果 |
| --- | --- |
| 断流与盘口深度 | 分别注入 Hyperliquid 的 `close` 和 `injected_disconnect`，两种策略均拒绝跨断点的 100 ms 委托，重合时长从旧实现的 270 ms 修正为 20 ms。同价位 `100.00 × 0.3` 更新为 `100.0 × 0.4` 后只能成交至 0.4，使用 `100 × 0` 可清空该档。 |
| 迟到资金费 | 将同一笔 Binance 结算记录从平仓前移到平仓后，并各重复投递一次。通过正式 CLI，两份交易 CSV 和两份逐腿 CSV 分别逐行一致（运行编号除外）。两个策略版本都只扣一次 0.1 USDT。 |
| 全量台账 | 仓内六个文件及两份解压内容的 SHA-256 均与清单一致。独立读取 58,941 条 CSV 数据行，以参数组合和交易编号关联全部 1,914 笔模拟成交。按四笔成交的原币价格、数量、费率及汇率重算手续费和合约损益，按方向、参考价和汇率重算 216 条资金费现金流，并核对每次结算均在对应持仓区间内。24 个组合共计 1,890 笔闭环、24 笔期末持仓，各组合已实现损益、期末估值和净资金费均与计分表及对比文件一致。不同组合复用同一段行情。 |
| 样本与来源 | 清单事件数为 2,622,792，等于各类计数之和及计分表处理数。第 15.4 节给出的绝对路径属于采集主机，本评审环境无法读取该文件。本次独立复算从成交明细开始。原始事件到成交的全链路重放仍待共享输入。 |

在 0.5 ETH、15 秒报价有效期、2 bps 开仓、100 ms 延迟下，增强版 52 笔闭环中 45 笔净盈利，已实现净额为 `+7.81110805 USDT`，计入期末持仓 `−1.09956276 USDT` 后合计 **`+6.71154529 USDT`**。同口径 BBO 基线按报告精度合计 `−145.398541 USDT`。断流修正使 15 秒档有效重合缩短 2,523 ms，交付的前后对比表显示全部组合的成交数与损益差额均为零。上述结果使用原生盘口和回退手续费。[逐笔成交](./phase1-9h-deliverables/trades.csv.gz) · [逐腿资金费](./phase1-9h-deliverables/funding_legs.csv) · [参数对比](./phase1-9h-deliverables/comparison-before-after.json)

### 16.2 流式回放的剩余边界与验收条件

1. **直接使用流式回放器时，迟到资金费会在导出和汇总中产生不同结果。** 沿用 16.1 的 1 ETH 样本，直接调用 `StreamingReplayRunner` 且省略结算索引。保留内存台账时，`onFinalizedRow` 在结算到达前已导出资金费 0，`finalize()` 后汇总才改为 −0.1。关闭台账保留时，汇总也为 0，净额从正确的 0.75962 变为 0.85962 USDT。文件 CLI 会预载结算索引，本次样本交付使用该路径。建议让需要最终账目的流式输出显式要求完整索引，或在结算齐备后再输出最终记录。回归覆盖不保留台账及有限采样两种模式，对比回调已写出的内容与最终汇总。[回调与保留顺序](../apps/backend/src/phase1/replay.ts#L1538) · [期末核账](../apps/backend/src/phase1/replay.ts#L2210)
2. **Binance 正在建立盘口时保存断点，续跑会丢失桥接所需输入。** 分别在“已收到首个增量、尚待 REST 快照”和“快照已到、尚待首个增量”两个时点保存并恢复。两组输入连续运行都成功桥接一次，双腿有效 270 ms、两版各触发一笔。相同输入切段后均为零桥接、零重合、零成交。断点只写出已同步盘口，恢复时清空缓冲增量及待桥接快照。请保存桥接中间状态，或只在可恢复的边界发布断点并从该位置续读。验收时逐项比较桥接、覆盖、成交与损益。[Binance 断点保存与恢复](../apps/backend/src/phase1/orderbook-state.ts#L411)

**下一次交付**可用上述两个小样本完成代码回归，同时提供原始 NDJSON 的只读下载位置或共享挂载。评审方可用第 15.4 节的 SHA-256 校验后，从同一原始输入独立重放。回归及独立重放通过后关闭第 9.3 节的剩余验收。团队可并行按现有参数开展下一段样本外验证，单独报告该窗口的净收益与期末持仓。

## 十七、第 16.2 节流式边界修正、全量回归与原始 NDJSON 只读下载交付（2026-11-28）

### 17.1 第 16.2 节两项边界修正与回归校验

1. **直接调用 `StreamingReplayRunner`（未预载结算索引）的迟到资金费回调与汇总一致性**（[replay.ts](../apps/backend/src/phase1/replay.ts)）
   - 当省略 `preloadedFundingSettlements` 时，已闭环 `TRIGGERED` 记录（`variant.deferredTriggeredRows`）不在平仓瞬间提前触发 `onFinalizedRow`；而是独立保留引用直至 `finalize()`（包含跨断点的 `exportCheckpoint` / `fromCheckpoint` 续跑），在全部结算记录接收完毕后统一执行 `reconcileRowFunding` 更新资金费、净盈亏及 `variant.metrics`，同步对齐 `variant.rows` 与 `delaySampleRows`，随后再触发 `onFinalizedRow`。
   - **效果**：即使设置 `retainRowsInMemory: false` 或有限采样上限 `maxRetainedRows: 1`（或分段断点续跑），`onFinalizedRow` 流式写出的记录与 `finalize()` 输出的 `summaries` 均完整包含迟到资金费且完全一致（在 1 ETH 回归测试输入中，平仓净利由漏记前 `+0.80955` 统一对齐为 `-0.1` 扣费后的 `+0.70955 USDT`，与早到对照组完全相同）。
   - 当使用 `runPhase1Replay`、`runPhase1ReplayStream` 或 CLI 时，因前置扫描已持有完整 `preloadedFundingSettlements`，闭环成交仍可在流式运行期零延迟实时写出，内存占保持 `O(1)`。
2. **Binance 盘口桥接中段断点的完整状态持久化**（[orderbook-state.ts](../apps/backend/src/phase1/orderbook-state.ts)）
   - `BinanceOrderBookStateMachine.exportCheckpoint()` 与 `restoreCheckpoint()` 现完整序列化并恢复 `BUFFERING` 阶段中的 `buffer`（已收增量列表）、`pendingSnapshot`（待桥接 REST 快照）、`droppedSincePending` 与 `archivedCrossFormatMutations`。
   - **效果**：无论在“已收到首个增量、尚待 REST 快照”还是“快照已到、尚待首个增量”处切段导出断点并恢复，续跑均可正确完成桥接，桥接次数（`1`）、双腿有效重合（`270 ms`）、两版策略触发次数（各 `1`）及成交损益与整段连续运行逐比特一致。
3. **测试与基准验证**（[phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts#L1423-L1695)）
   - 新增第 16.2 节两项专项回归；完整运行 `npm --workspace apps/backend exec -- tsc --noEmit`、`npx eslint`、`npm run build -w apps/backend` 与 `npm --workspace apps/backend test`（17 个测试文件、**242/242** 全部通过，含一期 `18/18`）。
   - 重跑 100,001 事件 / 1,000 档流式基准校验（`node apps/backend/dist/phase1/benchmark-replay.js --events 100000 --levels 1000`）：耗时 `7.22 s`（`13,856 events/s`）、峰值堆内存 `31.85 MB`、`rowsStreamedCount = 23,958`、`rowsRetainedInRamCount = 0`、`segmentedCheckpointParityExact = true`。

### 17.2 原始 9 小时录盘 `events.ndjson` 只读下载地址与核验命令

为便于评审环境直接获取原始 `events.ndjson`（2,622,792 行、2,630,789,890 字节）并完成独立全链路重放，已将其 gzip 压缩上传至本仓库只读 GitHub Release（[`phase1-9h-raw-20261127`](https://github.com/weixb1818-cmyk/gate-crossex/releases/tag/phase1-9h-raw-20261127)），上传前已本地校验 `gzip -dc` 解压字节流 SHA-256 与原始文件完全一致：

| 资产 | 下载链接 | 大小 | SHA-256 |
|---|---|---:|---|
| `events.ndjson.gz`（压缩原始录盘） | https://github.com/weixb1818-cmyk/gate-crossex/releases/download/phase1-9h-raw-20261127/events.ndjson.gz | 354,402,942 B (338 MB) | `0efc17dfe5d14039457b22fb606eb12e74aa87d05c097c0cec4791a2e401d73c` |
| 解压后 `events.ndjson` | `gzip -dc events.ndjson.gz > events.ndjson` | 2,630,789,890 B (2.5 GB) | `cb2abec6e39c0acc6f180c5c0ab111a3ab8a3f8c4928427c6b03fc23f5002ca1` |
| `manifest.json` | https://github.com/weixb1818-cmyk/gate-crossex/releases/download/phase1-9h-raw-20261127/manifest.json | 2,314 B | `e0632de0571811101720dc284226226f58324cbd972ee38fb9850d0d4461a9a4` |
| `SHA256SUMS.txt` | https://github.com/weixb1818-cmyk/gate-crossex/releases/download/phase1-9h-raw-20261127/SHA256SUMS.txt | 1,451 B | `2704a315787920bf62c39e0ca645decc4c6b83b4c3df2ea6504b34156129b6f6` |

评审方独立校验与全链路重放示例：
```bash
curl -L -o events.ndjson.gz https://github.com/weixb1818-cmyk/gate-crossex/releases/download/phase1-9h-raw-20261127/events.ndjson.gz
sha256sum events.ndjson.gz          # 0efc17dfe5d14039457b22fb606eb12e74aa87d05c097c0cec4791a2e401d73c
gzip -dc events.ndjson.gz > events.ndjson
sha256sum events.ndjson             # cb2abec6e39c0acc6f180c5c0ab111a3ab8a3f8c4928427c6b03fc23f5002ca1
npm run build -w apps/backend && npm --workspace apps/backend run phase1:replay -- \
  --in events.ndjson --out ./audit-repro --qty 0.500 --entry-bps-list 2,1 --delays-ms 0,100 --hl-max-age-ms-list 15000,10000,5000
```

至此第 16.2 节代码回归与原始 NDJSON 只读共享交付全部就绪，请评审团队校验并完成第 9.3 节最终验收；团队后续亦可按现有参数并行开展下一段样本外验证窗口。

## 十八、评审方从原始事件重放并验收第一期 ETH 样本（2026-11-28）

**提交 `ddf3d81` 通过第 9.3 节本次 9 小时 ETH 正式回放验收，第 16.2 节的迟到资金费和断点恢复两项问题已关闭。** 本轮从 Release 下载原始事件，在评审机重新构建后端、运行正式 CLI 并核对逐笔输出。后端 17 个测试文件共 242 项通过，含一期 18 项。[原始录盘 Release](https://github.com/weixb1818-cmyk/gate-crossex/releases/tag/phase1-9h-raw-20261127)

### 18.1 独立复现结果

| 核验对象 | 实测结果 |
| --- | --- |
| 原始输入 | 压缩文件与解压文件的 SHA-256 均与第 17.2 节一致。解压得到 2,630,789,890 字节、2,622,792 行，各类事件数与清单一致。 |
| 全量文件回放 | 使用 0.500 ETH、开仓阈值 2/1 bps、延迟 0/100 ms、HL 报价年龄 15/10/5 秒的 24 个组合。本机全量回放耗时 177.73 秒。从原始输入生成的计分表、报告、58,941 行交易及拒绝记录、216 行逐腿资金费明细，与第十五节交付物一致。比对时只统一运行编号、生成时间和报告中的本机输入路径。 |
| 资金费独立核算 | 从原始事件提取 1 次 Binance 和 9 次 Hyperliquid 实时结算，与 1,914 笔模拟成交逐笔匹配持仓区间。独立计算出的 216 笔逐腿现金流均与导出值相等。本样本所有跨结算持仓都持有至结算记录抵达，迟到记录的平仓核账由下行回归覆盖。 |
| 第 16.2 节回归 | 原迟到结算样本中，直接回放器在保留与关闭内存台账时均导出 −0.1 USDT 资金费，汇总相符。在“先增量后快照”和“先快照后增量”两处切断并续跑，均与连续运行结果相同，各桥接一次、有效重合 270 ms、两版各触发一笔。 |

### 18.2 下一段验证与一项估算差异

建议下一段样本外录盘沿用本轮参数，单独报告净收益和期末持仓，并优先核对账户实际费率。以 15 秒、2 bps、100 ms 的增强版为例，当期 52 笔已平仓、1 笔期末估值，合计净收益 **+6.71154529 USDT**。按本次模拟成交及期末估值使用的四腿价格计算，累计名义金额约 **177,257.12 USDT**。固定这些成交，若每次成交的费率均较假设高约 **0.379 bps**，本窗口净收益就会降至零。实际费率进入开仓判断后，成交集合也可能改变，届时用新费率重新回放。[逐笔成交](./phase1-9h-deliverables/trades.csv.gz) · [计分表](./phase1-9h-deliverables/scorecard.json.gz)

**后续处理缺少参考价的结算时，应统一两个入口的估算依据。** 将回归样本的 Binance 结算标记价置空，令平仓盘口为 `99.95 / 100.00`。文件回放使用中间价 99.975，1 ETH 多仓按 0.001 费率记 −0.099975 USDT。直接流式回放在期末核账时使用卖出成交价 99.95，记 −0.099950 USDT，两个入口却都标为 `book_mid_fallback`。建议在待核账记录中保留同一参考价、汇率和来源，并校验早到及迟到两种次序下的逐腿结果。本次 10 条实时结算的所需参考值全部齐备。[文件回放的平仓估算](../apps/backend/src/phase1/replay.ts#L1778) · [直接流式回放的期末核账](../apps/backend/src/phase1/replay.ts#L2255)

未预载结算索引时，直接回放器会把已闭环成交保留到期末再发回调，其内存需求随闭环笔数增长。长文件继续使用本轮验收的 CLI 入口，其预扫描结算索引后即可逐笔输出。[回调时机](../apps/backend/src/phase1/replay.ts#L1561)

## 十九、第 18.2 节 `markPrice` 缺失回退参考价统一修正（2026-11-28）

已按第 18.2 节要求统一文件回放与直接流式回放的缺失参考价回退逻辑（[replay.ts](../apps/backend/src/phase1/replay.ts)）：

* **修复内容**：`executePendingOrder` 平仓时刻将 `midpointFromView(bnCheck.view)`、`midpointFromView(hlCheck.view)`、`fxRate` 与 `fxSource` 一并存入待核账记录（`DeferredFundingRowEntry`），跨断点持久化还原；`reconcileRowFunding` 期末对账不再使用 `exit_long_fill.avgPriceNative` 替代中间价。
* **回归证明**（[phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts#L1708-L1844)）：构造 `markPrice: null`、平仓盘口 `99.95 / 100.00` 的 1 ETH 样本，在早到（`1080`）与迟到（`1220`）两种输入下，文件回放与直接流式回放（`retainRowsInMemory: false`）均一致按 `99.975`（`book_mid_fallback`）计提 `-0.099975 USDT`，全部后端 `17` 个测试文件 **`243/243` 通过**（含一期 `19/19`）、`tsc --noEmit` 与 `eslint` 零报错通过。

## 二十、开发团队对下一步工作的待确认问题（2026-11-28）

第一期 `ETH` 9 小时正式回放及全部回归（第 18、19 节）完成后，为确保第 18.2 节提及的**真实账户费率重算**、**下一段样本外验证**以及后续 **Phase 2 执行层接入**方向明确不返工，开发团队梳理出以下待与审计及业务方确认的问题：

### 20.1 真实账户费率核对与费率敏感度应对

1. **真实费率获取方式**：后端已具备通过 CrossEx `queryFeeRates` 接口结合凭证库拉取账户实际合同费率及 `specialFees` 列表的能力（[app.ts](../apps/backend/src/app.ts#L2143-L2195)），但当前采集主机未配置只读 API 凭证，故首期回放采用原生 VIP0/Tier-0 回退假设（Binance `0.0005` / Hyperliquid `0.00045`）。请问下一步是：**直接配置只读 API Key 自动拉取 CrossEx 统一账户针对 `BINANCE_FUTURE_ETH_USDT` 与 `HYPERLIQUID_FUTURE_ETH_USDC` 的实际费率**，还是**先按人工确认的账户 VIP/机构费率静态输入重算**？
2. **双 Taker vs Maker+Taker 边界**：第 18.2 节测算指出，在 `15s / 2bps / 100ms` 窗口中仅当单腿费率增量高于回退假设 `0.379 bps` 时净收益即降为零；如真实账户双 Taker 费率高于 VIP0 回退值并压缩正收益空间，下一步是**先在样本外继续观察双 Taker**，还是**并行在回放与 Phase 2 优先检验一腿挂单 Maker + 对冲保护价 IOC Taker 模式**？
3. **重算对照交付口径**：若真实费率进入 `vwap_taker_v2` 的开仓准入门槛并改变触发成交集合，下一轮报告是否要求同时并列输出**原 VIP0 回退费率**与**真实账户费率**两套结果以便连续比较？

### 20.2 下一段样本外验证窗口参数范围

1. **录制时长**：建议的下一段样本外实盘录盘计划持续多久？（仍保持 **9 小时以上**覆盖单次 Binance 8 小时结算，还是拉长至 **24 小时**覆盖全部 3 个 Binance 8 小时结算时段与日夜流动周期？）
2. **标的与场所覆盖**：下一段样本外是否仍**只录 `ETH`（`BINANCE + HYPERLIQUID`）**先验证样本稳定性，还是在同一采集进程中同步增加第 4.2 节预备标的 **`SOL`** 或对照场所 **`GATE`** 合约？
3. **正式回放入口固定**：第 18.2 节已指出直接内存运行器未预载索引时闭环缓冲内存随交易数增长；请确认后续所有长时样本外正式报告**统一以 CLI 流式预扫描入口（`phase1:replay`）作为唯一正式交付口径**。

### 20.3 Phase 2（执行接入与少人值守固定对）前置澄清

1. **行情信号源与下单执行路由拆分**：一期已实测 CrossEx 公共 WS 在 Binance 缺少初始快照与 `pu`、在 Hyperliquid 存在 ~12 秒推送滞后（第六节）。Phase 2 实盘中，是否明确**用交易所官方直连盘口驱动策略决策与风控保护，同时经 CrossEx 统一账户 API 发单执行**？若是，CrossEx 网关发单、撤单、成交回报及 REST 限流排队延迟将取代离线的 `100 ms` 敏感性假设——进入 Phase 2 前是否需要先做极小额真单/只读排队实测来测定实际发单 RTT 与各所 `LIMIT+IOC` / `MARKET+IOC` / `reduce_only` 语义？
2. **实盘资金额度与账户模式参数**：在进入多策略/固定对 Phase 2 试运行前，需业务与审计确认实际 CrossEx 账户模式下的关键风控阈值：**真实可用本金与单对预算配额**、**目标名义杠杆上限**（沿用估算的 `5x` 或下调至更保守值）、**单腿裸腿最大允许时长与强制降险阈值**，以及 **USDT/USDC 多币种担保折算与借款利率观测基线**（对齐第一.3、一.5 节与 CrossEx 实际账户规则）。
3. **二期启动准入顺序**：请确认执行节奏是**先完成样本外录盘与真实费率重算并经审计复核后再启动 Phase 2 实盘极小额测试**，还是**在样本外录盘的同时并行开展 Phase 2 订单语义探测、账户费率接入与保证金预留联调**？

## 二十一、评审方对下一段录盘、账户费率与二期排期的答复（2026-11-28）

**开发团队现在可以启动独立的 24 小时 ETH 样本外录盘。** 账户费率快照、回放费率输入和二期影子执行可与录盘并行。下一次评审以“同一策略在新行情、账户费率下还剩多少净收益”为首要问题。极小额真单另行决定。

### 21.1 第十九节复核

已核对修复提交 `5bc192a` 和提问提交 `5b3a985`。沿用第 18.2 节的 1 ETH 样本，资金费记录早到和迟到时，正式 CLI 与直接流式回放均以中间价 99.975 记账，资金费均为 −0.099975 USDT。新版断点续跑也得到同一结果。独立运行后端类型检查、构建及 243 项测试，全部通过。**第 18.2 节估算差异关闭。**

另有一项升级兼容问题可随费率改动处理。从 `ddf3d81` 导出含待核账成交的旧断点，用新版恢复时，读取 `entry.row.opportunity_id` 会抛出异常。旧记录只保存成交行，缺少平仓时的回退中间价。请识别旧格式，对无法精确恢复的断点提示从原始事件重放，并加一个跨版本用例。本轮新窗口使用新目录，从原始事件开始录制与回放。[断点恢复](../apps/backend/src/phase1/replay.ts#L1121)

### 21.2 账户费率与策略对照（答 20.1）

1. **首选账户只读 API，人工快照可先行。** 由账户负责人在受控环境配置只读凭证，复用 `queryFeeRates`。向回放程序提供脱敏快照即可，公共录盘进程无需持有凭证。为两个完整合约代码分别匹配 `specialFees`，无匹配时用该场所永续的 Maker/Taker 费率。保存合约、角色、十进制费率、取值来源、抓取时间和适用时段。人工输入应有该账户的费率凭据并单列来源。只有 VIP 等级或公开表时仍按假设标注。缓存过期或权限未就绪时，先交基线，账户费率栏标为待核。[现有费率接口](../apps/backend/src/app.ts#L2137) · [Gate 账户费率说明](https://www.gate.com/zh/help/crossex/functional/49701) · [CrossEx API 字段](https://www.gate.com/docs/developers/crossex/en/)
2. **双 Taker 是本轮主实验。** 第 18.2 节的 0.379 bps 是固定成交集合、两所每笔开平仓费率均同幅增加时的盈亏平衡点。若只改变一所的费率，原 9 小时主档的平衡增量约为 Binance 0.758 bps 或 Hyperliquid 0.757 bps。Maker + 保护价 IOC 可以并行做影子实验，单列挂单未成交、部分成交、撤单期间成交、对冲滑点及残仓。仅凭盘口触价无法确认排队成交。缺少成交和排队依据时只报情景范围。
3. **同窗并列两套费率。** 保留原回退费率的整套结果，再用账户费率从第一条事件重跑，把费率同时用于开仓门槛、四笔费用及期末估值。额外在原成交集合上只替换费用，以拆出纯费用变化和成交集合变化。旧 9 小时数据作对照，新的 24 小时独立出表。事后取得的费率若缺乏历史生效证据，历史列标为“按该快照的情景重算”。给正式 CLI 增加可复用的脱敏费率快照输入，并保留现有默认配置。[现有费率模型](../apps/backend/src/phase1/replay.ts#L23) · [回放 CLI](../apps/backend/src/phase1/replay-cli.ts#L275)

### 21.3 录盘范围与验收（答 20.2）

- **窗口取连续 24 小时，策略验证仅覆盖 ETH 固定对。** 主盘口沿用 Binance USDⓈ-M 与 Hyperliquid 永续，CrossEx 继续旁路记录。SOL、新交易对和新增执行场所留待本次报告之后。启动前登记 UTC 起止、代码版本及参数，沿用第 9.1 节的 0.500 ETH、2,000 USDT 模拟预算和完整 24 组合。主读数固定为 15 秒、2 bps、100 ms 的增强版。按实际发布的结算记录核对覆盖。如 Binance 维持 8 小时周期，预计覆盖 3 次。缺口、重连、零成交或亏损窗口均原样交付。
- **所有正式长文件报告统一用 `phase1:replay`。** 提交两窗各自的输入校验值、可读位置、费率快照和复现命令。报告列双腿有效时长、触发及闭环笔数、费用、资金费、已实现净损益、期末可平估值及无法估值的数量。主档另给出逐时损益与持仓，使团队能看出结果是否集中于个别时段。冻结参数后在本窗作出的任何调参，只能在后续窗口验证。

### 21.4 二期可并行的工作与真单条件（答 20.3）

| 工作 | 安排与验收 |
| --- | --- |
| 行情与订单路由 | 同意按“原生直连盘口形成信号和保护价、CrossEx 统一账户执行”设计二期，先用影子模式生成订单意图。为新行情源明确检查合约身份、连接健康、双时间戳、深度与 FX，并记录同期 CrossEx 可比报价及偏离。新仓报价失效时停止新增风险。保留现有实盘来源校验，待新适配器及故障用例通过后再接入。[现有报价校验](../apps/backend/src/strategy-engine.ts#L764) |
| 订单语义与延迟 | 现在可按合约核对 `LIMIT + IOC` 保护价、`POC` 和 `reduce_only` 的请求字段，用模拟网关覆盖零成交、部分成交、迟到成交及重启对账。`MARKET + IOC` 单列验证，价格上限由带限价的委托表达。分别记录排队、发出、确认、成交和撤单确认时间。只读 RTT 用于评估读路径，真实订单延迟留待获批试单测量。0/100 ms 继续用于离线对照。[CrossEx 下单规范](https://www.gate.com/docs/developers/crossex/en/) |
| 共享保证金与少人值守 | 有只读数据后，核对账户模式、权益、可用与维持保证金、USDT/USDC 抵押折算、负债与借款利率。在模拟账户验证并发预留、部分成交后的释放、超限停开、减险与告警。重启后先按订单、累计成交和实仓对账。独立资金费策略沿用第二节排期，先用当时可见的预测值模拟进出场，并用实际结算核账。 |
| 极小额真单 | 先交新窗口、账户费率重算及影子故障用例供复核，再由业务方决定是否试单。届时须明确账户与实拨资金、单对及每笔名义上限、杠杆上限、保证金缓冲、裸腿金额与最长时限、最大试验损失、触线后的撤单/减险动作及停机负责人。第 9.1 节的 2,000 USDT 与 5 倍仅为模拟参数。业务限额或授权未定，实盘测试配置中的实盘开仓额度设为零。 |

**下次送审分两步。** 先回报新窗口起止、配置和费率快照进度。24 小时结束后提交双费率对照与逐笔产物，同时附二期影子验证结果及仍需业务决定的参数。若真实费率下机会消失，保留零成交或净亏结果，优先复核执行成本及 Maker 情景，再决定是否值得投入实盘试验。

## 二十二、24 小时 ETH 样本外录盘启动登记与第 21 节首步汇报（2026-11-28）

### 22.1 第 21.1–21.3 节代码就绪（提交 `59ffbf2`）

已先行完成以下配套实现、测试并推送至 `origin/main`（全部后端 `17` 个测试文件 **`245/245` 通过**，含一期 `21/21`，`tsc --noEmit` 与 `eslint` 零报错）：

1. **旧断点升级兼容护栏**（[replay.ts](../apps/backend/src/phase1/replay.ts)）：恢复 `ReplayCheckpoint` 时显式识别缺失平仓回退中间价的 `ddf3d81` 旧格式 `deferredTriggeredRows` 并抛出提示“请从原始 `events.ndjson` 重放”的明确错误；已在 [phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts) 补齐跨版本恢复测试。
2. **脱敏账户费率快照与纯费率反事实对比**（[replay.ts](../apps/backend/src/phase1/replay.ts)、[replay-cli.ts](../apps/backend/src/phase1/replay-cli.ts)）：新增 `resolveFeeScheduleFromSnapshot`、`computeCounterfactualFeeImpactOnFixedTrades` 以及 CLI 参数 `--fee-snapshot <path>` 与 `--compare-fee-snapshot <path>`，按合同完整代码优先匹配 `specialFees` 并回退场所永续默认费率，同时保留原 `VIP0 fallback` 默认口径及标注溯源字段。
3. **主档 UTC 逐时损益与持仓报表**（[replay.ts](../apps/backend/src/phase1/replay.ts)、[replay-cli.ts](../apps/backend/src/phase1/replay-cli.ts#L243-L257)）：`report.md` 第 3.1 节与 `scorecard.json` 自动输出主档（`15s / 2bps / vwap_taker_v2 / 100ms`）各 UTC 整点的开仓数、闭环数、期末留存持仓数及盈亏/费用/资金费拆解。

### 22.2 24 小时 ETH 样本外录盘启动登记（第一阶段汇报）

| 登记项 | 启动实测登记值 |
|---|---|
| 采集代码版本 | `59ffbf2cc5d632b1d7a28b8c01cea78a13de5127` |
| 输出目录 | `/home/ubuntu/gatex/gate-crossex/.local-data/phase1/oos-24h-20261128` |
| 标的白名单与场所 | `ETH` 固定对 · 主源：`BINANCE USDⓈ-M (ETHUSDT)` + `HYPERLIQUID (ETH)`；旁路：`CrossEx WS` |
| 计划起止时间（UTC） | **启动**：`2026-11-28T09:25:29.797Z` → **计划结束（+86,400s）**：`2026-11-29T09:25:29.797Z` |
| 启动状态核验 | `session_meta` 已剥离本地代理变量；HL 首帧 `20/20` 档应用（`1795857930353`）；BN 快照 `lastUpdateId="12265697580993"` 桥接 `SYNCED`（`1012/1003` 档，`1650.45 / 1650.46`）；注入断流定时：`+1,800s` |
| 预计覆盖结算 | Binance 3 次 8 小时结算（`16:00Z`, `00:00Z`, `08:00Z`）+ Hyperliquid 24 次整点结算 |
| 回放冻结参数 | `Q = 0.500 ETH`, `budget = 2000 USDT`, `leverage = 5x`, `entry_bps = 2,1`, `tp_bps = 0`, `exit_buffer = 1 bps`, `delays = 0,100 ms`, `hl_age = 15s,10s,5s`, `bn_age = 15s`；主档：`15s / 2bps / vwap_taker_v2 / 100ms` |
| 账户费率快照进度 | **待核（pending）**：采集主机 `.env` 与本地凭证库暂无 CrossEx 只读 API 凭证（`credential_not_configured`）；已支持脱敏快照注入 `--fee-snapshot`，待账户负责人提供脱敏费率快照或只读凭证后即对本窗与原 9h 窗同步输出双费率对照 |
| 二期并行边界 | **严格影子模式（实盘开仓额度设为 `0`）**：录盘期间仅并行开发与测试直连行情适配器校验及 CrossEx 模拟网关影子/故障用例，不产生任何真实委托 |

## 二十三、二期影子架构与故障对账验证记录及 VIP0 账户费率状态说明（2026-11-28）

按第 21.4 节并行开发要求，在不中断 24 小时 ETH 样本外录盘的前提下，已完成二期直连行情校验、CrossEx 订单语义构造、账户级共享保证金与故障模拟验证代码，所有实盘开仓额度严格锁定为 **`liveOpenNotionalCapUsd = '0'`**（零真实发单）：

### 23.1 二期并行模块与验证回归摘要

| 模块 | 覆盖范围 | 对应文件 |
| --- | --- | --- |
| **直连行情适配器 (`NativeDualMarketAdapter`)** | 校验合约目录状态（`BINANCE_FUTURE_ETH_USDT` / `HYPERLIQUID_FUTURE_ETH_USDC`）、WS 断连/缺口状态、双时间戳、可视深度、`FX` 新鲜度及同期 CrossEx `cx_raw` 可比报价偏离阈值；异常即冻结新增风险（同时保留实盘路径 [strategy-engine.ts](../apps/backend/src/strategy-engine.ts#L764) 原检验未动） | [native-market-adapter.ts](../apps/backend/src/phase2/native-market-adapter.ts) |
| **CrossEx 订单语义与模拟网关 (`SimulatedCrossExGateway`)** | 构造并校验 `PROTECTIVE_LIMIT_IOC`、`MAKER_POC`、`MARKET_IOC`（显式标记无价差保护上限）与 `reduce_only` 载荷；记录 5 段生命周期时间戳（`decisionTs` → `queuedTs` → `dispatchedTs` → `ackedTs` → `firstFillTs`/`terminalFillTs`/`cancelRequestedTs`/`cancelConfirmedTs`）；注入零成交 IOC、部分成交 IOC 触发 `reduce_only` 减平、挂单 `POC` 撤单期间迟到成交去重，并与真实 [`TradingRuntime`](../apps/backend/src/trading-runtime.ts) 联调恢复 `AMBIGUOUS_SUBMIT_THEN_FILLED` 及 `quiesceOpenOrders` | [shadow-gateway.ts](../apps/backend/src/phase2/shadow-gateway.ts) · [shadow-runner.ts](../apps/backend/src/phase2/shadow-runner.ts) |
| **共享保证金与独立资金费路径 (`SharedMarginCoordinator`)** | 多策略并发额度竞争与部分成交释放、强锁 `liveOpenNotionalCapUsd = '0'` 拦截实盘下单、裸腿金额/时长/试错亏损/维持保证金四项护栏联动撤单减平、重启后挂单与仓位一致性门控，以及基于点时可见 `funding_pred` 与实付 `funding_settled` 对账的资金费路径评估 | [shared-margin-coordinator.ts](../apps/backend/src/phase2/shared-margin-coordinator.ts) · [shadow-runner.ts](../apps/backend/src/phase2/shadow-runner.ts) |
| **工程校验结论** | `tsc --noEmit` 零报错、`eslint apps/backend/src/phase2/*.ts` 零告警、`npm run build -w apps/backend` 成功、全量 Vitest **`18` 个测试文件 `256/256` 通过**（含 [phase2.test.ts](../apps/backend/src/phase2/phase2.test.ts) `11/11` 与 [phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts) `21/21`） | [phase2.test.ts](../apps/backend/src/phase2/phase2.test.ts) |

### 23.2 账户 VIP0 状态与费率待核口径确认

* **现状说明**：业务方确认当前 CrossEx 正式账号尚未开启交易、无任何 VIP 等级（普通 VIP 0 账号），且 Gate CrossEx 官方唯一的费率文档（[49701](https://www.gate.com/zh/help/crossex/functional/49701)）原文未提供静态费率表，原文仅载明：**“Gate VIP 等级将决定跨所账户的交易费率。费率下限可能不定期调整，跨所账户具体费率请以 `/api/v4/crossex/fee` 实时返回结果为准。”**（对应后端 [`queryFeeRates`](../apps/backend/src/crossex-client.ts) 接口）。因此回放默认的原生场所 VIP 0 回退假设（Binance `0.0005` / Hyperliquid `0.00045`）仍按假设单列，账户实测费率保持 `pending` 等待开户后以只读凭证拉取。
* **后续衔接**：24h 样本外录盘继续后台运行（`PID 3108038`，截至 `18:07+08:00` 已写入 `142,712` 行、`107M`）；待账号启用并取得只读凭证/脱敏费率快照后，即利用已就绪的 `--fee-snapshot` / `--compare-fee-snapshot` 能力，在同一窗口上输出 VIP 0 回退假设与 CrossEx 实测 VIP 0 账户费率的双口径对照，并在必要时同步补充 Maker+IOC 影子对比场景。

### 23.3 送审基线（`34c9124`）、第 21.4 节逐项对照与复现命令

请评审团队按以下逐条映射表核验本轮并行交付（代码基线 `34c9124`），并可在任意环境直接运行复现命令：

| 第 21.4 节验收项 | 本轮交付状态 | 代码证据与实测边界 |
| --- | --- | --- |
| **行情与订单路由**（直连盘口校验、CrossEx 可比偏离冻结、现网实盘未动） | **离线模块与单测已就绪；现网未切流** | [native-market-adapter.ts](../apps/backend/src/phase2/native-market-adapter.ts) 覆盖合约目录、断连/缺口、双时间戳、深度、`FX` 与 `cx_raw` 偏离；[strategy-engine.ts](../apps/backend/src/strategy-engine.ts#L764) 实盘逻辑未改动 |
| **订单语义与延迟**（`LIMIT+IOC` 保护价、`POC`、`reduce_only`、`MARKET+IOC` 单列、5 段时间戳、模拟故障覆盖） | **影子构造与模拟故障单测已通过；真实发单 RTT 待获批试单测量** | [shadow-gateway.ts](../apps/backend/src/phase2/shadow-gateway.ts) · [shadow-runner.ts](../apps/backend/src/phase2/shadow-runner.ts) 覆盖零成交、部分成交 + `reduce_only` 减平、撤单期迟到成交及真实 `TradingRuntime` 的 `504` 超时恢复与 `quiesceOpenOrders` |
| **共享保证金与少人值守**（并发预留/释放、护栏减险、重启对账、独立资金费路径；实盘只读账户待核） | **模拟并发/护栏/对账与资金费评估已通过；CrossEx 只读账户核对 `pending`** | [shared-margin-coordinator.ts](../apps/backend/src/phase2/shared-margin-coordinator.ts) · `evaluateFundingStrategyPathComparison`；真实账户权益/抵押/负债字段映射待只读凭证到位后实盘采集核对 |
| **极小额真单门槛** | **严格锁定未放行** | `DEFAULT_SHADOW_RISK_LIMITS.liveOpenNotionalCapUsd = '0'` 强拒一切 `mode === 'LIVE'` 资金预留 |

评审团队本地独立复现命令：

```bash
npm --workspace apps/backend exec -- tsc --noEmit \
  && npx eslint apps/backend/src/phase2/*.ts \
  && npm run build -w apps/backend \
  && npm --workspace apps/backend test
```

（2026-11-28 实测全量通过：**`18/18` 测试文件、`256/256` 项测试通过**，其中 [phase2.test.ts](../apps/backend/src/phase2/phase2.test.ts) `11/11`、[phase1.test.ts](../apps/backend/src/phase1/phase1.test.ts) `21/21`。）

### 23.4 请评审与业务方确认的阶段性问题（等待 24h 录盘完成期间）

1. **阶段代码先审确认**：请审计确认提交 `34c9124` 的 Phase 2 直连适配器、CrossEx 订单语义校验、共享保证金并发/护栏及模拟网关故障用例是否通过本轮阶段复核，以便在 24 小时录盘收口前消除执行层结构性问题。
2. **VIP 0 费率就绪时序确认**：截至当前，业务方 CrossEx 正式账号尚未开启交易且为普通 VIP 0（无只读 API 凭证）。若到 `2026-11-29T09:25:29Z`（24h 样本外录盘结束）时账号仍未激活：是否允许开发团队按第 21.2 节先交付**原生 VIP 0 回退假设下的 24h 全量与逐时基线报告**（账户费率栏明确标为 `pending`）并同步附带敏感度 / Maker+IOC 影子分析，待后续只读 Key 就位后再补充 `--compare-fee-snapshot` 双费率对照？
3. **后续极小额真单风控默认值复核（当前仍锁定 `liveOpenNotionalCapUsd = '0'`）**：[shared-margin-coordinator.ts](../apps/backend/src/phase2/shared-margin-coordinator.ts#L37) 当前暂置的影子/试错默认值（`shadowAccountBudgetUsd = 2000`、`maxPairNotionalUsd = 2000`、`maxOrderNotionalUsd = 1000`、`maxLeverage = 5`、`minAvailableMarginBufferRatio = 0.15`、`maxNakedNotionalUsd = 1000`、`maxNakedDurationMs = 5000ms`、`maxTrialLossUsd = 25`）仅作代码回归使用；待 24h 样本外与实际 VIP 0 费率复核后如拟讨论试单，请业务与审计届时指定正式实拨限额与停机负责人。
