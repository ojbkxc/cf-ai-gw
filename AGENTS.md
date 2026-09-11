# AGENTS.md — cf-ai-gw

> 给 AI 编码代理的仓库指南。规则分三级:**Never(禁止)/ Ask first(先问)/ 默认自主**。
> 每条硬规则都对应一个真实踩过的坑,不要试图绕过。
> 优先级:本文件 > `README.md`。

## 0. 项目速览(新会话必读)

**cf-ai-gw** 是 Cloudflare Worker(纯 JS 单文件 ES Module,无构建无编译):把 Workers AI
(AI Binding `env.AI.run()`)转成 OpenAI/Anthropic 兼容 API,自带 `/admin` 可视化管理面板。
单账号、内部 RPC 调用,无需 API Token。看板口径为 Token(非 CF 计费 Neurons)。

- **仓库**:https://github.com/ojbkxc/cf-ai-gw(main 分支,直接 push,不走 PR)
- **入口**:`src/index.js`(模式 A,~7000 行,唯一维护入口)
- **弃用**:`_worker.js`(模式 B,REST API 多账号 failover,仍在仓库但不再维护,
  两入口同步规则已失效;重启模式 B 前先评估漂移)
- **线上**:https://cf-ai-gw.lxseek.workers.dev(用户另有自定义域)
- **架构**:KV 存配置(`cfg_api_keys/cfg_model_map/cfg_gpt_alias/cfg_model_tokens/cfg_limits`)
  与用量汇总(`tokens_daily_/tokens_monthly_/evt_`);DO `ApiKeyCounter` 限次强一致、
  DO `UsageCounter` 今日用量;isolate 内 Map 做并发闸;cron UTC 0 点清 10 天前 usage DO。
- **部署**:push 即触发 Cloudflare Git 集成自动部署,**无 CI、无本地编译**,
  `node --check` 是唯一本地验证手段。

## 1. Never(硬性禁止,违反即返工)

1. **禁止绕过幂等句柄直调 `releaseModelSlot(cfModel)`**——并发槽位释放必须走
   `makeSlotReleaser(cfModel)` 句柄(详见 §3)。2026-09-11 曾因直调引发双重释放,
   `modelInflight` 计数下溢、并发闸失效放行超限请求。
2. **禁止在未等部署生效前宣称任务"完成/已验证"**——push 后 Cloudflare 部署传播约
   **5 分钟**,立即测试会命中旧版本实例导致误判(踩过 sdxl"假失败"坑)。
3. **禁止把任何 API Token/密码写入 commit**——`ADMIN_PASSWORD` 在 `wrangler.toml` `[vars]`
   明文是用户明确要求的唯一例外(仓库为 public,已知情);其他 secret 走
   `wrangler secret put`。CF API Token 只经环境变量 `CLOUDFLARE_API_TOKEN` 传入。
4. **禁止在 `save*` 写 KV 后不调 getter 的 `.invalidate()`**——配置读取全部走
   `createKVGetter`(60 秒闭包缓存),漏 invalidate 表现为"保存失效"(踩过的坑)。
   新增配置键时同步新增 getter 与 invalidate 调用。
5. **禁止绕过 getter 直接 `KV.get('cfg_*')`**——所有配置读取必须走 `createKVGetter`。
6. **禁止改 `wrangler.toml` 的 Worker `name`**——当前 `cf-ai-gw`,改回旧名 `api` 会误建
   新 Worker(踩过一次)。`compatibility_date` 也不动。
7. **禁止发版只推 tag**——用户发版必须**双发**:tag(`git tag -a vX.Y.Z -m "..."` + push)
   和 GitHub Release(独立对象,须调 `POST /repos/ojbkxc/cf-ai-gw/releases` 单独创建,
   JSON 体经 `@file` 传参防中文 400)。tag 必须指向最新功能提交(v1.0.0 曾打错需删重打)。
8. **禁止跳过回写本文件**——每次会话结束前必须更新「§6 变更日志」(最新在上,记做了
   什么/改了哪些文件/是否验证/下一步);排查 0 产出也要记一行。用户明确说"不用更新"
   才可跳过。当本文件与代码矛盾时,以代码为准并立即回写消除漂移。
9. **禁止 `git add -A`**——只 add 本次改动的文件。

## 2. 硬约束速查(违反会导致返工)

| 维度 | 约束 |
|---|---|
| 运行时 | Cloudflare Workers,`compatibility_date = "2025-08-01"`,ES Module |
| 静态检查 | `node --check src/index.js`(改后必跑) |
| KV | binding `KV`,id `692bd958d51b4890a02b5fe637cddae2`(与模式 B Pages 共用,数据互通) |
| DO | `ApiKeyCounter` / `UsageCounter`,migrations 随 `wrangler.toml` |
| cron | `["0 0 * * *"]` UTC 0 点清 10 天前 `usage:<date>` DO storage |
| 凭据 | `ADMIN_PASSWORD` = `[vars]` 明文(用户要求);其余 secret 走 wrangler secret |
| 模型映射 | `DEFAULT_MODEL_MAP` + `DEFAULT_MODEL_TOKENS`(仅 src/index.js) |
| 请求次数限额 | 已禁用(`getUsageLimits` 三个硬编码 0),并发限额是唯一闸 |

新增 `@cf/` 模型流程:核官方目录(https://developers.cloudflare.com/workers-ai/models/) →
加映射与 token 上限 → `owned_by` 由 `getModelOwnedBy` 从 `@cf/` 路径自动提取,无需维护前缀表。

## 3. 并发槽位规则(最高优先级)

**背景**:流式路径是双层结构——`callBindingChat` 用 `wrapStreamWithRelease` 包装外层流,
handler 又把 `result.stream` 传入内层 transform(`passthroughStream` /
`anthropicStreamTransform` / `responsesStreamTransform`),**两层各持释放义务**。

**Why**:两层都直调 `releaseModelSlot` → 同一槽位释放 2 次 → `modelInflight`/
`globalInflight` 下溢 → 并发闸失效放行超限;反之漏掉任一路径 → 计数只增不减 →
并发耗尽后永久 429,必须重启 Worker。流被客户端取消、上游超时、上游报错都是常态,
每条都可能不走 done 分支。

**How to apply**:

1. `acquireModelSlot(cfModel, max, globalMax)` 成功后立即
   `const releaseSlot = makeSlotReleaser(cfModel);`(闭包 `released` 标志保证幂等)。
2. 流式:`callBindingChat` 把句柄同时交给 `wrapStreamWithRelease(..., releaseSlot)` 与
   返回值 `result.releaseSlot`;调用点把 `result.releaseSlot` 传给 transform 末位参数
   `releaseSlot = null`。
3. 三个 transform 的三条退出路径(`pull` done / `pull` catch / `cancel`)各加
   `if (releaseSlot) releaseSlot();`(3×3=9 处)。
4. 非流式 handler(embeddings/images/audio 等)用 `try { ... } finally { releaseSlot(); }`。
5. 句柄幂等:谁先到终点谁释放,另一方调用是安全 no-op。

**验证**(每次动并发相关代码必跑):
```
grep "releaseModelSlot("     → 必须仅 2 处(定义 + makeSlotReleaser 内部)
grep "if (releaseSlot) releaseSlot();" → ≥ 9 处(3 transform × 3 路径)
```

## 4. 验证与部署闭环(本项目无 CI,部署即验证)

```
理解任务 → 就绪判定 → 手术式实现 → node --check → push main
    ↑                                                │
    └── 修根因,盲试 ≤ 2 次 ←── 端点验证失败 ←── 等 ~5 分钟部署生效 ←─┘
```

1. **就绪判定**:需求含糊时先列方案与取舍,不猜;多方案呈现 tradeoff,不沉默选择。
2. **手术式修改**:只改必须改的;不"顺手"重构、不动无关格式;匹配现有风格。
3. **本地检查**:`node --check src/index.js` + grep 关键符号(见 §3 验证、§1.4/§1.5)。
4. **push 即部署**:Cloudflare Git 集成自动部署;纯文档改动无需等验证。
5. **端点验证**(全绿才算完,**等 ~5 分钟再测**):
   - `GET /v1/models` → 返回模型列表
   - `GET /admin` → 登录页 HTML
   - 管理员登录 → `GET /api/settings` → 配置 JSON
   - 涉及推理的改动:`POST /v1/chat/completions`(带 API Key)实测
   - **本机 curl.exe 不走系统代理**,测试 workers.dev 用 Invoke-WebRequest/.NET;
     PS5.1 传 JSON 用 UTF8.GetBytes
6. **部署失败/运行报错**:`npx wrangler tail` 看实时日志或查 Dashboard 部署状态,
   定位首个 Error/TypeError 行,本地修复后重新 push,循环直到全绿。不许带病推进。
7. **自动推进**:用户说"继续/auto"或未叫停时,自主连续推进下一个子任务,不等许可;
   仅方向性分歧、破坏性操作、违反硬约束时才问。
8. **不许宣称被阻塞**:没实际尝试就说 not attempted,被挡下要引用真实报错。
9. **结束卫生**:不留未提交改动;最终答复附 commit SHA 或验证结果;回写 §6 变更日志。

## 5. Ask first(先问再做)

- 切换部署模式(改 `wrangler.toml` 的 `main` 到 `_worker.js`)——模式 B 已弃用且有漂移。
- 重新开启请求次数限额(`getUsageLimits` 三个硬编码 0)——用户已裁决保持禁用。
- 删除/弱化本文件的任何 Never 规则。
- 发新版本(涉及 tag 双发流程)。
- 改看板口径(Token ↔ Neurons)。

## 6. 变更日志(最新在上)

- **2026-09-11(首页今日用量中文量级读数 + reasoning 字段名对齐)**:① 首页「今日用量
  汇总」大数字下方新增一行小字中文量级读数(约 X 万 / 约 X 亿),新增 fmtCn(n) 函数:
  ≥1亿→n/10^8 两位小数「亿」,≥1万→n/10^4 两位小数「万」,<1万→千分位精确值;采用万/亿
  两级(中文最自然,百万=100万/十亿=10亿均可覆盖),不用「百万/十亿」固定词避免「1.23百万」
  别扭读法。方案比选:括号并排 vs 下面加一排——选后者,不挤 42px 主数字、主次层级分明、
  滚动动效不需改。② reasoning token 字段名对齐:accumulateFromUsage(非流式)、anthropic
  流式、passthrough 流式三处,由仅读顶层 u.reasoning_tokens 改为
  `?? u.completion_tokens_details?.reasoning_tokens ?? 0` 双结构兼容——CF 若按 OpenAI 标准
  返回嵌套 reasoning_tokens,明细卡「推理 N」不再恒 0。③ fmtTok/首页数字显示保持原样
  (K/M/B 与千分位精确值),仅新增辅助读数,不波及其他共用处。node --check OK。未部署验证。
  改动文件:src/index.js。
- **2026-09-11(彻底移除 AI Gateway 挂载)**:用户裁决选 C(完全移除),commit 27cea0f。
  删除 `aiRunOptions()`(gateway.id=ojbkxc + cacheTtl 3600),5 个 env.AI.run 调用点
  (chat 流式/非流式、embeddings、images、whisper)改为直传 `{signal/returnRawResponse}`。
  理由:① 缓存是完整请求体匹配,多轮对话永不命中,命中率低;② 硬编码默认挂 ojbkxc
  网关,平台侧删网关即全站推理 500 的隐性耦合;③ 网关平台侧日志非刚需。
  同步删 wrangler.account2.toml 的 `AI_GATEWAY_ID = "off"`(默认不挂了,该开关无意义)。
  **注意**:主部署 wrangler.toml 从未配过此 var,线上行为变化=不再挂网关/无缓存,
  若上游异常优先怀疑此项回滚。node --check OK。未部署验证。
  改动文件:src/index.js + wrangler.account2.toml。
- **2026-09-11(Tokens 计算全链路检测 + 两项修正)**:应用户要求全量检测 token 计算
  方式,commit 317de20。**结论**:防重复计费(流式入口 request+流末 token 双段、
  countRequest/writeEvent 语义)、total=input+output 口径、UTC 日期一致性、估算类
  (embeddings/images/whisper ceil(len/3))均正确。**修正两项**:① 删除 evt_<date>_<uuid>
  事件键写入(accumulateTokens 的 writeEvent 分支)——aggregateEventsByDate 早已移除,
  全文件无人读取该键,纯死写入白付 KV 写;同步清理 6 处过时注释、3 处
  writeEvent:false 调用参数、TOKEN_KV_TTL_SEC 注释口径;② 模型归因统一为「用户请求
  模型名」——原 6 处 accumulateFromUsage 用 shortModelName(cfModel)(实际服务模型),
  与流末补 token 的用户模型名口径不一致,经别名/回退调用时今日模型占比会拆裂成
  "A:N请求/0 token"+"B:0请求/M token"两条;现 request 与 token 同口径,与面板按模型
  并发的配置键一致。**遗留已知项(不修)**:今日 Token 明细卡片(getTodayTokenStats)只读
  KV 汇总键、无 DO 兜底,并发覆盖丢写时短暂偏低;扩 DO schema 需加 reasoning/cacheRead
  等字段,涉及 UsageCounter 类结构变更+跨版本兼容(旧 DO 实例存的是三字段对象,新代码
  读缺字段需防御),收益仅是统计展示短暂偏差自愈,不值得。node --check OK。未部署验证。
  改动文件:src/index.js。
- **2026-09-11(密钥有效期控件最终简化:永久复选框+天数输入框单行)**:用户裁决
  datetime 控件 bug 太多整体废弃,commit 74b75c6(-116/+29):① 删除 datetime-local
  控件、picker-launcher、外置「确定时间」按钮及配套 JS(onKeyDateChange/
  confirmKeyDate/onKeyExpiresLauncherClick/toDatetimeLocalInput/showPicker CSS);
  ② 改为单行合并:「永久」label + 复选框 + 天数输入框 + 「天」单位,CSS 隐藏 number
  上下箭头(-webkit-appearance:none + -moz-appearance:textfield);③ 逻辑:
  勾选永久→天数框置灰清空且提交一律按永久;取消勾选→天数框可填(两位小数,0.5=半天),
  oninput 即时 hint 换算到期时间;提交时 days>0 才算有效 ISO,否则创建拦截/编辑保持
  原值;④ 编辑预填改为剩余天数((到期-现在)/天,两位小数),不动则 PUT 不带
  expiresAt。后端 expiresAt 直收逻辑不变。node --check OK。未部署验证。
  改动文件:src/index.js。下一步:部署后实测创建/编辑/永久置灰。
- **2026-09-11(首页新增接入信息卡片)**:用户要求三种接入格式在首页公开展示(接在
  API 密钥查询下方)。公开页新增「接入信息」section-card,复用 admin 同款
  access-endpoint 卡片三枚(OpenAI /v1/chat/completions、Responses /v1/responses、
  Anthropic /v1/messages),点击复制。三个实现点:① 公开页 style 块原本没有
  access-endpoint-* 样式(admin 专属),已复制适配(minmax 240px 适配窄屏);②
  id 用 home-*-endpoint-url 避免与 admin 冲突,window.onload 回填 origin+path;
  ③ 公开页没有 copyEndpointUrl(原本只在 admin script 块),已补独立定义
  (内部走 SHARED_JS 的 copyText)。node --check OK。commit 4d0fc29,未部署验证。
  改动文件:src/index.js。
- **2026-09-11(「确定时间」按钮恢复)**:用户实测浏览器 datetime 弹框**只有清除按钮、
  没有确认按钮**(8d8add0 移除外置按钮的判断错误——弹框自带确认不成立,不同环境
  行为不一致)。恢复日期控件下方「确定时间」按钮:选完日期 onchange 只给即时提示
  (「已选 X,点确定时间生效」),点按钮才反算天数框并给 ✓ 确认反馈;按钮随
  「永久有效」勾选联动置灰;openAdd/openEdit 三态同步 disabled。commit fc58067,
  未部署验证。改动文件:src/index.js。
- **2026-09-11(密钥有效期日期控件:整框弹选择器 + 主题适配)**:用户反馈 datetime-local
  弹框自带确认没做好 + 希望点击整个日期显示框都能弹出选择控件。修复:① 外层
  `picker-launcher` div onclick → `showPicker()`(用户手势内调用;旧浏览器降级
  focus;disabled 直接 return;点控件本身不拦截交给浏览器);② CSS 补
  `input[type=datetime-local]{color-scheme:dark}`(暗色主题日历图标反色,light 主题
  对应 light)与禁用态 `opacity .5 + grayscale`(此前禁用无视觉反馈);③ 控件
  cursor: pointer。node --check OK。commit 3a28f7f,未部署验证。改动文件:src/index.js。
  下一步:部署生效后验证创建/编辑弹框交互。
- **2026-09-11(7 日走势 Tokens 修复:两处流式 usage 死引用)**:用户报告「过去 7 日消耗走势
  Tokens 出问题」,排查结论:① 数据链(KV 键口径/排序/前端映射)正常;② 上午 2c54add 曾
  破坏 `tokens_daily_` 键拼接语法(f8ee9e7 已修),09:20-09:51 窗口数据缺失属历史事故,
  无法回补;③ **真正根因**:passthroughStream(3423)与 responsesStreamTransform(2979)
  的 accumulateTokens 调用引用未定义变量 `model`(参数名分别为 modelName/originalModel)
  ——与 a6835a2 修的 anthropicStreamTransform 死引用完全同源,是全量检测漏网之鱼。
  流式 OpenAI chat / Responses 请求一拿到 usage,done 分支抛 ReferenceError 被 catch
  吞掉 → 流中断 + token 永不入账 → `tokens_daily_` 汇总偏低 → 走势图异常。修复:
  `model: modelName,` / `model: originalModel,`。grep 复查 3 个 transform 全部
  accumulateTokens 调用点(2021/2135/2246/2431/2563/2664/2905/2979/3423/3485)无残留
  裸 model 引用;node --check OK。commit 63e44c4,未部署验证(等 ~5 分钟)。
  改动文件:src/index.js。下一步:部署生效后看 7 日走势恢复入账。
- **2026-09-11(全量检测 5 项 bug 修复 + 日期控件确认交互修正)**:**bug 修复**(三路并行
  审查发现,commit a6835a2):① anthropicStreamTransform 的 sendFinalEvent 用了未定义
  变量 `model`(实为参数名 `modelName`),流式 /v1/messages 拿到 usage 即 ReferenceError
  → 流式 token 永不入账且收尾被打断;② per-model 并发配置死引用 `cfPayload._userModelName`
  全文件无赋值处,面板「按模型并发」永不生效——改为 callBindingChat 显式传
  userModelName(用户请求模型名口径);③ createKVGetter 缓存 rejected promise 60s,一次
  瞬时 KV 故障 → 全部 /v1 请求 500 一分钟——失败不缓存;④ 熔断器误计 4xx 客户端错误
  (cbOnCapacityFail 改为仅 isCapacityError 时调用,8 个坏请求不再全局开闸);⑤
  acquireModelSlot max<=0 与 globalMax<=0 同语义=不限(配 0 不再全站 429)。
  **UI 交互修正**:日期控件外置「确定」按钮移除(浏览器日期弹框自带确认),选完 onchange
  即刷新天数框。未部署验证。改动文件:src/index.js。
- **2026-09-11(密钥有效期控件交互重构:天数↔日期联动 + 确定按钮)**:按用户 5 点规则重做
  模态框:① 「永久有效」checkbox 最高优先级,勾选则天数框/日期控件/确定按钮全部置灰清空;
  ② 新增天数输入框(支持两位小数,如 0.5=半天),与 datetime-local 双向联动
  (onKeyDaysChange:天数→日期=现在+N 天;onKeyDateChange:日期→天数=(到期-现在)/天,
  保留两位);③ 日期控件旁加「确定」按钮(confirmKeyDate,校验必须晚于当前时间);
  ④ 创建时有效期必填:永久或有效日期二选一,否则 toast 拦截;⑤ 编辑时 KEY_EXPIRES_DIRTY
  跟踪用户是否动过时间控件——未动过则 PUT 不带 expiresAt 字段,后端保持原值;动过则按
  当前状态提交。hint 提示行全程引导(勾选状态/换算结果/确定锁定)。验证:node --check OK;
  事件绑定 4 处齐全(oninput/onchange)。**注:api 密钥明文展示在 UI 上是用户明确允许的
  设计(复制功能需要),勿作为安全缺陷报告。**未部署验证。改动文件:src/index.js。
  下一步:部署生效后实测创建/编辑/联动/永久置灰交互。
- **2026-09-11(双重释放修复 + 密钥有效期控件统一 + 首页信息精简 + AGENTS.md 精简重写)**:
  ① 上轮给三 transform 加的 `releaseModelSlot` 直调与 `wrapStreamWithRelease` 外层释放
  双重冲突(用户质疑促成复查),重构为 `makeSlotReleaser` 幂等句柄贯穿全链路(transform
  末位参数 `releaseSlot`、done/catch/cancel ×9 处、非流式 handler 句柄+finally),commit
  78c2454。② 密钥有效期统一「永久 checkbox + datetime-local」控件:创建默认勾选永久、
  编辑预填当前到期日(不动=保持原值),后端 POST/PUT 直收 `expiresAt`(ISO,null=永久),
  保留 days/months 兼容。③ 首页密钥查询精简:剩余次数去掉冗余「已用 N」,"描述"改"名称";
  admin 表头与模态框文案同步。④ **本文件按 Lxchat/AIGX 三级规则风格精简重写**
  (Never/Ask first/自动闭环 + 硬约束速查表),旧版超长历史日志归档于 git 历史(78c2454^)。
  未部署验证(等 ~5 分钟)。改动文件:src/index.js + AGENTS.md。
  下一步:部署生效后验证并发流式计数与密钥查询展示。
- **2026-09-10 ~ 09-11 前史摘要**:看板本地兜底 + 密钥有效期/次数 + 公开查询 + 流式计数
  与 KV 竞态修复(7 commits 已线上验证)→ 限额拦截 DO 快速路径 + 卡片合并 + DO cron 清理
  (46f6851)→ 流式槽位释放初版(有双重释放 bug,当日已修)+ README 重写(b624ede)→
  密钥有效期三处修复(a623278)→ 首页 Tokens 单位统一(5b35604)。细节见 git log。

## 7. 参考文件

- 部署/模式/端点/环境变量:`README.md`
- CF 官方模型目录:https://developers.cloudflare.com/workers-ai/models/
- wrangler 配置:`wrangler.toml`
