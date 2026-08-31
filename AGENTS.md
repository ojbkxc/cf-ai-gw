# AGENTS.md — cf-ai-gw 项目代理工作指引

> 本文件供 AI 编码代理（含未来会话）进入项目时**首先自读**，快速对齐项目定位、当前进度、架构契约与下一步任务，然后**继续完善未完成的代码**。
> 优先级：本文件 > `README.md`。

---

## R0. 强制规则（MANDATORY，不可绕过）

> 本节是*最高优先级的强制约束*，凌驾于一切其他指引之上。违反即视为流程失败。

1. **每次会话必须先自读本文件**：进入项目后，在执行任何写代码/搜索/构建动作之前，必须先 `read` 完整 `AGENTS.md`，对齐「当前进度」「下一步任务」「接口契约」。
2. **每次会话结束前必须回写本文件**：无论本次完成了几项任务（含 0 项，即仅排查/失败），在结束前**必须**用 `edit`/`write` 更新本文件至少一处：
   - **必须**更新「§4 变更日志」追加一行（最新在上），记录本次做了什么、改了哪些文件、是否通过验证、下一步建议。
   - **必须**更新「当前进度」与「下一步任务」的勾选状态以反映真实状态。
   - 若改动了接口契约或模型映射，*必须*同步更新「§2 硬约束」与「§3 仓库结构」。
3. **本文件是单一事实源（single source of truth）**：当本文件与代码、与 `README.md`、与口头描述出现矛盾时，**先以代码为准**，然后*立即回写本文件*消除漂移。
4. **不得删除或弱化本节**：任何对「§R0 强制规则」的删减、降级、加「视情况而定」修饰，都需用户明确同意；代理自身不得自行放宽。
5. **回写是义务而非可选**：即使用户未要求「更新 AGENTS.md」，每次会话结束前也必须执行回写；用户明确说「不用更新」时才可跳过，并在变更日志注明「依用户要求跳过本次回写」。
6. **两入口必须同步**（MANDATORY）：项目有**两个独立入口**——`src/index.js`（模式 A：AI Binding，单账号）与 `_worker.js`（模式 B：REST API，多账号 failover）。两者各自维护一份 `DEFAULT_MODEL_MAP` / `DEFAULT_MODEL_TOKENS` / `createKVGetter` / `save*`。**任何对默认模型映射、token 上限、KV 缓存逻辑、配置键的改动，必须在两个文件同步修改**，否则切换 `wrangler.toml` 的 `main` 字段时行为不一致。改完必须用 grep 校验两文件对应符号出现次数一致。
7. **KV 缓存写后必须失效**（MANDATORY）：所有配置读取走 `createKVGetter`（60 秒闭包缓存 `_promise`）。**任何 `save*` 函数在 `env.KV.put()` 之后，必须调用对应 getter 的 `.invalidate()`**，否则保存后立即读取（如管理面板保存后 `loadSettings` 重载）会命中缓存返回旧值，表现为「保存失效」。新增配置键时，同时新增 getter 与对应 save 的 invalidate 调用。
8. **部署验证必须通过 push 到 GitHub 触发 Cloudflare 自动部署**（MANDATORY）：本地无 Cloudflare 运行时，**无法**直接运行 Worker。任何代码改动后的验证必须通过 `git commit && git push` 提交到 `origin`（`https://github.com/ojbkxc/cf-ai-gw.git`，分支 `main`），由 Cloudflare Pages/Workers 的 Git 集成自动部署。**禁止**在未 push 且部署成功前声称某子任务「完成/已验证」。AGENTS.md 等纯文档改动不触发 Worker 部署，但仍随 push 同步到仓库。
9. **通过部署后端点验证迭代修复**（MANDATORY）：push 后若 Cloudflare 部署失败或运行时报错，*必须*读取部署日志/错误，本地修复后*再次 commit & push*，循环直到部署成功且端点可用。*不得*跳过部署失败直接推进下一子任务。验证端点：`GET /v1/models`（模型列表）、`GET /admin`（管理面板）、`GET /api/settings`（配置）。
10. **自动推进项目（auto-continue，默认行为）**（MANDATORY）：用户说「自动继续」「继续」「auto」或未明确叫停时，代理*必须自主连续推进*项目任务，不得每完成一小步就停下来询问下一步。具体要求：
    - 进入项目后按 §0 流程**自主**挑选下一个最高优先级的最小可独立交付子任务并开工。
    - 单个子任务完成后**立即**开始下一个，无需请求许可；仅在遇到「方向性分歧」「破坏性操作」「违反硬约束」「信息严重不足且无法合理推断」时才用 `question` 工具询问用户。
    - 推进过程中*主动*跑 §R2.3 部署验证闭环、§R0 回写，不要等用户提醒。
    - 停下汇报时应附「已完成的 / 正在做的 / 下一步打算做的」三段式摘要。

---

## R2. Cloudflare 部署验证策略（MANDATORY，配合 §R0.8–R0.9）

> 本节落实 §R0.8/R0.9 的「push 到 GitHub 触发 Cloudflare 自动部署 + 据报错修复」闭环。本地无 Cloudflare 运行时，push → 部署 → 端点验证是*唯一*验证通道。

### R2.1 部署触发条件
- **push 到 `origin/main`**：Cloudflare Workers 的 Git 集成监听 `main` 分支，push 后自动构建并部署 `wrangler.toml` 中 `main` 字段指定的入口文件。
- 当前 `main = "_worker.js"`（模式 B）。切换模式只需改 `wrangler.toml` 的 `main` 字段并 push。
- 无独立 CI workflow：Cloudflare 直接部署 JS 源码，无构建步骤（无 npm install / bundle）。

### R2.2 部署后必须验证的端点（全绿才算通过）
```
Worker 部署成功后，用 curl 或浏览器验证：
1. GET https://cf-ai-gw.<subdomain>.workers.dev/v1/models
   → 返回 JSON，data 数组含 DEFAULT_MODEL_MAP 的所有模型 id（如 deepseek-v4-pro-0813、glm-5.2）
2. GET /admin → 返回管理面板 HTML（登录页）
3. 登录后 GET /api/settings → 返回 { customModelMap, modelTokens }
4. POST /v1/chat/completions（带 API Key，model 用新映射）→ 返回 OpenAI 兼容响应
```
部署后若端点 500/超时/返回空，按 §R2.3 修复。

### R2.3 据报错修复的迭代流程（每次 push 后必走）
1. `git push origin main`。
2. 在 Cloudflare Dashboard → Workers & Pages → cf-ai-gw → Deployments 查看部署状态；或用 `wrangler tail` 看实时日志。
3. 若部署失败或运行时报错：读日志定位首个 `Error` / `TypeError` / `SyntaxError` 行。
4. 本地按报错修代码（常见：两入口不同步、缓存未 invalidate、模型映射 key 写错、ES Module 语法）。*不*绕过。
5. 本地先跑 §R2.4 静态检查，再 `git commit && git push`，回到步骤 2，直到部署成功且端点可用。
6. 部署成功且端点验证通过后才能在 §4 勾选该子任务「完成」并注明「部署验证通过」。

### R2.4 本地可做的静态检查（push 前自检，减少部署往返）
- **`node --check` 语法检查**：两文件是 ES Module（`export default`），需用 `.mjs` 扩展名检查：
  ```powershell
  Copy-Item src/index.js $env:TEMP\check_a.mjs -Force
  Copy-Item _worker.js $env:TEMP\check_b.mjs -Force
  node --check $env:TEMP\check_a.mjs
  node --check $env:TEMP\check_b.mjs
  ```
- **两入口对称性检查**：用 grep 确认 `DEFAULT_MODEL_MAP` / `DEFAULT_MODEL_TOKENS` / `createKVGetter` / `save*` / `.invalidate()` 在两文件中对应符号出现次数一致（模式 A 无 `saveAccounts`/`getAccounts`，其余应对称）。
- **缓存 invalidate 覆盖检查**：每个 `createKVGetter(...)` 创建的 getter，其对应 `save*` 函数末尾必须有 `.invalidate()` 调用。
- **无绕过 getter 的直接 KV 读取**：`grep "KV.get('cfg_"` 应为 0（所有配置读取走 `createKVGetter`）。
- **`git status` 确认无残留未 commit 修改**：会话开始前与 commit 前各执行一次。
- 人工 review：模型映射 key 是否以 `@cf/` 开头、token 上限是否正整数。

### R2.5 wrangler.toml 维护
- **不要**在 `wrangler.toml` 里加 KV/AI Binding/环境变量配置——这些在 Cloudflare Dashboard 中配置，推代码不会覆盖。
- 切换部署模式：改 `main` 字段为 `"src/index.js"`（模式 A）或 `"_worker.js"`（模式 B）后 push。
- 新增环境变量（如限额阈值）在 Dashboard Settings → Variables & Secrets 配置，代码里通过 `env.XXX` 读取。

---

## 0. 进入项目后的标准流程（必读）

1. **通读本文件**（尤其是「§R0 强制规则」「当前进度」「下一步任务」三节）。
1b. **`git status` 检查残留修改**：若工作目录有未 commit 的修改，先理解其内容并 commit，再开始新工作。*不要* `git stash` 或 `git checkout -- .` 丢弃前次修改——先搞清楚是什么。
2. 按「下一步任务」的优先级顺序挑选一个*最小可独立交付*的子任务开工。
3. 开工前用 `read`/`grep`/`glob` 阅读相关已有代码，*复用既有函数与命名*，不要另起炉灶。改默认模型/映射/tokens/缓存逻辑时，**先读 `src/index.js` 与 `_worker.js` 对应区段确认两文件当前是否一致**。
4. 每完成一个子任务：执行 §R2.4 静态检查清单，然后 `git add -A && git status` 确认所有修改已 staged，`git commit && git push` 触发 Cloudflare 部署验证。
5. **回写本文件**（强制，见 §R0）：更新「当前进度」「下一步任务」勾选状态，并在「变更日志」追加一行。
6. **不要**主动 `git commit`，除非用户明确要求或子任务已通过 §R2.4 静态检查准备部署。*不要*写未经请求的 README/文档。*不要*加注释除非用户要求。
7. **会话结束前再次确认 §R0 的回写已执行**；若未执行，补做后再结束。

---

## 1. 项目定位（一句话）

cf-ai-gw 是 **Cloudflare Workers AI → OpenAI/Anthropic 兼容 API 网关**（Cloudflare Worker，纯 JS/ES Module），自带 `/admin` 管理面板，支持多账号负载均衡与故障自动切换，把 `@cf/` 系列模型暴露为 OpenAI 兼容的 `/v1/chat/completions` 等端点。

## 2. 硬约束（任何改动都不得违反）

| 维度 | 约束 | 验证方式 |
|---|---|---|
| 远程仓库 | `https://github.com/ojbkxc/cf-ai-gw.git`，分支 `main` | `git remote -v` |
| 部署机制 | push `main` → Cloudflare 自动部署，无独立 CI | Cloudflare Dashboard Deployments |
| 入口文件 | `src/index.js`（模式 A）/ `_worker.js`（模式 B），`wrangler.toml` `main` 切换 | `wrangler.toml` |
| 模块格式 | ES Module（`export default`） | `node --check *.mjs` |
| 运行时 | Cloudflare Workers，`compatibility_date = "2025-08-01"` | `wrangler.toml` |
| KV 绑定 | Variable name = `KV`（Dashboard 配置，不在 wrangler.toml） | Dashboard Bindings |
| 必填环境变量 | `ADMIN_PASSWORD`（Dashboard） | Dashboard Variables & Secrets |
| 配置 KV 键 | `cfg_model_map` / `cfg_model_tokens` / `cfg_api_keys` / `cfg_limits` / `cfg_accounts` | `createKVGetter` 调用 |
| 缓存 | `createKVGetter` 60s 闭包缓存，`save*` 必须 `.invalidate()`（§R0.7） | grep `.invalidate()` |
| 模型映射 | `DEFAULT_MODEL_MAP` + `DEFAULT_MODEL_TOKENS`，**两文件同步**（§R0.6） | grep 对称性 |
| 模型 owned_by | `@cf/` 路径自动提取（`getModelOwnedBy`） | `getModelOwnedBy` |
| 无构建步骤 | push 即部署，无 npm install/bundle | — |

新增 `@cf/` 模型时：在两文件 `DEFAULT_MODEL_MAP` 加映射、`DEFAULT_MODEL_TOKENS` 加上限（如有）。`owned_by` 由 `getModelOwnedBy` 从 `@cf/` 路径自动提取（如 `@cf/meta/xxx` → `meta`），无需维护前缀表。

## 3. 仓库结构

```
cf-ai-gw/
├── AGENTS.md          # 本文件（代理工作指引）
├── README.md          # 项目说明（部署/模式/端点/环境变量）
├── wrangler.toml      # Cloudflare Worker 部署配置（name/main/compatibility_date；KV/AI/变量在 Dashboard）
├── src/
│   └── index.js       # 模式 A 入口（AI Binding，单账号，env.AI.run()）
└── _worker.js         # 模式 B 入口（REST API，多账号 failover，fetch() 公网）
```

两入口各自完整包含：`DEFAULT_MODEL_MAP`、`DEFAULT_MODEL_TOKENS`、`getModelOwnedBy`、`createKVGetter`、`resolveModelName`、`/api/settings` 端点、`/admin` 管理面板 HTML+JS。**改任何共享逻辑必须两文件同步**。

## 4. 当前进度与下一步任务

### 当前进度
- [x] 内置默认模型映射（glm/kimi/deepseek/llama/qwen 等）
- [x] 管理面板（账号/API Key/模型映射/Tokens/限额）
- [x] 多账号 failover（模式 B）
- [x] KV 配置缓存（createKVGetter）
- [x] **新增 deepseek-v4-pro-0813 / deepseek-v4-flash-0731（1048576 tokens），排在 glm-5.2 前**
- [x] **修复 Tokens 保存失效（createKVGetter 加 invalidate，所有 save* 调用）**
- [x] **创建 AGENTS.md（本文件）**
- [x] **修正 README 第41行「加密存储」→「以明文存储」（删除错误声称）**
- [x] **移除 safeJsonBody 大小限制（两入口同步，4 处调用点去参）**
- [x] **P2-8 checkUsageLimit threshold<=0 短路跳过 KV 读（性能提升，两入口）**
- [x] **P2-6 HTML 响应加 X-Content-Type-Options/X-Frame-Options + csrf cookie 加 Secure（两入口）**
- [x] **P2-7 /api/tokens/today 注释「公开」→「需管理员认证」（模式 B）**
- [x] **P2-4 safeJsonBody 错误文案「too large」→「Invalid or missing JSON body」、status 413→400（两入口）**
- [x] **核对 CF 官方目录更新模型映射：移除 8 个弃用/过时模型，替换+新增 8 个最新模型，补全 token 上限**
- [x] **改造 getModelOwnedBy：移除 CF_OWNER_MAP 前缀表，改为从 @cf/ 路径自动提取 owner**
- [x] **/v1/models 按 token 上限从大到小排序（两入口）**
- [x] **管理面板 loadSettings 模型映射列表按 token 降序排序（两入口）**
- [x] **更新 README.md 内置模型列表（按类别分组+Tokens 列）、模式对比表、端点列表**
- [x] **修复模式 A handleMessages 缺 openaiBody.model=cfModel（/v1/messages 非流式 500）**
- [x] **修复模式A 5个独有bug（流式pingInterval清理/剩余buffer兜底/data前缀/账号测试路由）**
- [x] **修复模式A Binding响应格式归一化（env.AI.run原生格式→OpenAI格式）**
- [x] **修复模式A流式Binding格式归一化（passthroughStream/anthropicStreamTransform的processLines）**
- [x] **修复全量安全评估12条缺陷（P2×3+P3×9，清单见 final-security-assessment-20260831-201409.md）**

### 下一步任务（待用户决策，按优先级）
- [x] **P1-A 补滥用防护**：用户裁决跳过——Cloudflare 平台自带限流
- [ ] **P1-B 修正限额拦截时效与口径**：模式 B 拦截基于过期 GraphQL 缓存 + Neurons/token 混用，两入口口径不一致（主动刷新影响性能，暂不做）
- [ ] **P1-C 为模式 B 增加熔断/重试上限**：failover + 可恢复流无熔断，坏请求可放大 8+ 倍上游推理（熔断需状态维护影响性能，暂不做）
- [ ] P2-1/P2-2/P2-3/P2-5：KV read-modify-write 丢失更新、流式 token 漏记、错误码一律 server_error、会话 token 静态无撤销（均需状态维护或改错误行为，影响性能/复杂度高，暂不做）

## 5. 变更日志（最新在上）

- **2026-08-31（修复全量安全评估12条缺陷 P2×3+P3×9）**：依据 `final-security-assessment-20260831-201409.md` 清单逐条修复，`node --check` 两文件通过（EXIT=0），grep 验证全绿。改动文件：`src/index.js` + `_worker.js`。逐条说明：① **P2-1**（src/index.js 音频转写 OOM）：移除 `parseInt(Content-Length || '0')` 头依赖（chunked 时=0 绕过），改用 `request.clone().body.getReader()` 流式累计实际字节数，上限 100MB→25MB；`{ audio: [...audioUint8] }` 数组展开改为 `{ audio: audioUint8 }` 直接传 Uint8Array，避免 1 亿元素数组内存放大 8 倍+ OOM。② **P2-2**（src/index.js 流式 finish_reason 缺失）：两个 processLines 加 `else if (!chunk.choices && chunk.usage !== undefined)` 分支处理 CF 流式尾块 `{usage}`（无 choices/response），构造 `{choices:[{delta:{},finish_reason:chunk.finish_reason||'stop'}],usage}`，保留上游真实 finish_reason 避免 ensureFinishReason 覆盖。③ **P2-3**（src/index.js normalizeBindingResult 兜底）：兜底路径从 `return result`（原样返回非 OpenAI 格式）改为构造空 choices 的 OpenAI 格式 `{choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage}`。④ **P3-1**（_worker.js accountId 路径注入）：`buildCFUrl` + 3 处 fetch URL 的 `${account.accountId}` / `${targetAccountId}` 全部加 `encodeURIComponent()`，共 4 处。⑤ **P3-2**（CSRF 非时序安全比较）：两入口 `csrfCookie !== csrfHeader` 改为 `!timingSafeEqual(csrfCookie, csrfHeader)`，2 处。⑥ **P3-3**（CSRF cookie 缺 HttpOnly）：两入口 csrf cookie 字符串加 `HttpOnly;`，2 处。⑦ **P3-4**（图片 width/height 无上限）：两入口 `parseInt(parts[0]) || 1024` 改为 `Math.min(Math.max(parseInt(parts[0]) || 1024, 64), 2048)`，限制 [64,2048]，4 处。⑧ **P3-5**（/api/accounts/test 永远成功）：模式 A 从硬编码 `success:true` 改为实际调用 `env.AI.run('@cf/google/embeddinggemma-300m', {text:['test']})` 做轻量推理测试。⑨ **P3-6**（前端账号 CRUD 与后端不匹配）：loadAccounts 中 `acc.id === 'binding-single'` 时不显示编辑/删除按钮，显示"由 Binding 配置（只读）"。⑩ **P3-7**（API key 明文回传）：两入口 GET /api/keys 返回 `maskTokenKey(k.key)` 掩码，2 处。⑪ **P3-8**（timingSafeEqual 长度提前返回）：无需修改，比较值都是 sha256 64 字符恒定长度。⑫ **P3-9**（流式 chunk.response 非字符串）：两个 processLines 的 `content: chunk.response` 改为 `content: typeof chunk.response === 'string' ? chunk.response : JSON.stringify(chunk.response)`，2 处。⑬ §R0.6 同步：P3-4/P3-7 虽然缺陷清单只列 src/index.js，但 _worker.js 有相同问题，已同步修复。下一步建议：用户 push 部署验证。
- **2026-08-31（修复模式A流式Binding格式归一化）**：① 根因：CF Workers AI Binding `env.AI.run(model,{messages,stream:true})` 流式返回的 SSE chunk 是**原生格式** `{response:"...",usage,tool_calls}` 而非 OpenAI 格式 `{choices:[...]}`（证据：CF 官方文档 llama-3.3-70b 的 Streaming Output 仍有 `response`(string)/`usage`/`tool_calls` 字段，与 Synchronous Output 相同；参考项目 `openai-cf-workers-ai` 的 chat.js 第 70 行 `delta: { content: data.response }`——从 SSE chunk 读 `data.response` 手动转成 OpenAI delta）。模式 A `callBindingChat` 流式分支用 `returnRawResponse:true` 获取 Response 直接透传 `resp.body`，但后续两个 processLines 函数都假设输入是 OpenAI 格式（读 `chunk.choices`），导致原生格式 chunk 被错误处理。② 现象：位置1 `passthroughStream` 的 processLines（src/index.js:2090）直接透传原生格式 chunk，OpenAI 客户端收到 `{response}` 解析 `choices` 失败；位置2 `anthropicStreamTransform` 的 processLines（src/index.js:1482）`chunk.choices` 是 undefined → `choice` undefined → `if (!choice) continue` 跳过所有内容 chunk → Anthropic 流式客户端收到空响应。模式 B 走 REST API 返回 OpenAI 格式不受影响。③ 修复：在两个 processLines 的 `const chunk = JSON.parse(dataStr);` 之后、其他逻辑之前，加防御性格式归一化——`if (!chunk.choices && chunk.response !== undefined)` 时构造 OpenAI streaming chunk `{id,object:'chat.completion.chunk',created,model:modelName,choices:[{index:0,delta:{content:chunk.response},finish_reason:null}],usage?}`，`const chunk` 改成 `let chunk`（因重新赋值），`modelName` 是外层函数参数（passthroughStream/anthropicStreamTransform 都有）内层闭包可访问。向后兼容：已是 OpenAI 格式（有 choices）时跳过归一化不破坏现有行为。④ 改动文件：仅 `src/index.js`（+约 26 行），未动 `_worker.js`（模式 B 走 REST API 返回 OpenAI 格式不需要此修复，§R0.6 不需同步）。⑤ 验证：`node --check` 通过（EXIT_CODE=0），grep 确认 `!chunk.choices && chunk.response !== undefined` 2 处（第 1485 行 anthropicStreamTransform + 第 2106 行 passthroughStream）、`let chunk = JSON.parse(dataStr)` 2 处（第 1482 行 + 第 2103 行）。⑥ 下一步建议：用户 push 部署验证。
- **2026-08-31（修复模式A Binding响应格式归一化）**：① 根因：CF Workers AI Binding `env.AI.run(model,{messages})` 非流式返回原生格式 `{response:"...",usage,tool_calls}` 而非 OpenAI 格式 `{choices:[...]}`（证据：CF 官方文档 llama-3.3-70b Parameters 部分显示非流式返回 response/usage/tool_calls；CF OpenAI 兼容文档说 OpenAI 格式只在 REST 端点 `/ai/v1/chat/completions`，"Normally Workers AI requires model name in env.AI.run"（原生格式）；参考项目 `openai-cf-workers-ai` 用 `aiResp.response` 手动构造 OpenAI 格式、`duckgpt` 做 4 种格式兼容 response/choices/output/string）。现象：模式 A `handleCompletions`（src/index.js:1021-1040）直接 `jsonResponse(cfJson)` 返回原生格式导致 OpenAI SDK 解析 choices undefined 失败；`handleMessages`（src/index.js:1343-1345）把原生格式传给 `convertOpenAIToAnthropic`（:1214 用 `openaiResponse.choices?.[0]`）导致 Anthropic 响应 content 数组为空。模式 B `callOpenAICompatibleAPI`（_worker.js:1298）走 REST API OpenAI 兼容端点返回 OpenAI 格式不受影响。② 修复：新增 `normalizeBindingResult(result, cfModel)` 函数（检测 choices 数组→直接返回；检测 response 字符串→构造 OpenAI 格式 `{id,object,created,model,choices:[{index,message:{role,content,tool_calls?},finish_reason}],usage}`；兜底原样返回），在 `callBindingChat` 非流式返回前调用（流式分支用 `returnRawResponse:true` 透传 SSE 不动）。向后兼容：已是 OpenAI 格式时直接返回不破坏现有行为。③ 改动文件：仅 `src/index.js`（+约 28 行），未动 `_worker.js`（模式 B 用 REST API 不需要）。④ 验证：`node --check` 通过（EXIT_CODE=0），grep 确认 `normalizeBindingResult` 2 处（函数定义第 751 行 + 调用第 810 行）、`data: normalizeBindingResult` 1 处。⑤ 下一步建议：用户 push 部署验证。
- **2026-08-31（修复模式A 5个独有bug）**：① 修复 `src/index.js` 5 个模式 A 独有 bug（模式 B `_worker.js` 已正确，不动）：BUG-A-1 anthropicStreamTransform catch 块缺 pingInterval 清理（第 1426 行新增 `if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }`，对照 `_worker.js:1935`）；BUG-A-2 passthroughStream done 分支剩余 buffer 错误加 `data: ` 前缀（第 2009 行 `data: ${buffer.trim()}\n\n` → `${buffer.trim()}\n\n`，对照 `_worker.js:2563`）；BUG-A-3 passthroughStream catch 块缺 pingInterval 清理（第 2037 行新增，对照 `_worker.js:2592`）；BUG-A-4 anthropicStreamTransform done 分支缺剩余 buffer 兜底（第 1395-1397 行新增 `if (buffer.trim()) { controller.enqueue(encoder.encode(\`${buffer.trim()}\n\n\`)); }`，对照 `_worker.js:1902-1905`）；BUG-A-5 前端 testConnection 调 `/api/accounts/test` 但后端无此路由（第 2237-2247 行新增简化成功响应，模式 A 用 AI Binding 无 apiToken，权限由平台 Binding 配置保证）。② 根因：5 个 bug 均为模式 A 实现遗漏，模式 B 已正确实现。③ 改动文件：仅 `src/index.js`（+约 20 行），未动 `_worker.js`（§R0.6 不需同步，模式 B 已正确）。④ 验证：`node --check` 通过（EXIT_CODE=0），grep 确认 `if (pingInterval) { clearInterval` 6 处（4 原有 done+cancel + 2 新增 catch）、`/api/accounts/test` 2 处（前端调用 + 后端路由）。⑤ 下一步建议：用户 push 部署验证（push 由用户自行执行）。
- **2026-08-31（修复模式 A /v1/messages 非流式 500）**：① 修复：模式 A `src/index.js` 的 `handleMessages` 在 `convertAnthropicToOpenAI` 之后补充 `openaiBody.model = cfModel`（第 1294 行，1 insertion），与模式 B `_worker.js` 第 1803 行写法对齐。② 根因：Workers AI 上游用请求 body 中的 `model` 字段做模型校验（而非 URL 第一参数），模式 A 未将 body model 覆盖为 `@cf/` 路径，导致上游报 `The model glm-4.7-flash does not exist`（实测：body model 为用户模型名返回 404，model 为 `@cf/` 路径或无 model 字段返回 200）。③ 现象：仅 `/v1/messages`（Anthropic 格式）非流式失败；`/v1/chat/completions` 正常（cfPayload 不含 model 字段）；模式 B 正常（已有覆盖行）。④ 验证：`node --check` 两文件通过，grep 对称性通过（`openaiBody.model = cfModel` 两入口各 1 处）。commit ceac6e0（push 由用户自行执行）。
- **2026-08-20（README.md 更新 + 管理面板排序）**：① 更新 README.md「内置模型」部分：移除已弃用模型（deepseek-r1-distill-qwen-32b、llama-3.1-8b 等），按类别分组（文本生成/向量嵌入/多模态/语音），文本生成带 Tokens 列按 token 降序，新增 22 个文本生成 + 17 个其他模型的完整列表；模式对比表「模型列表」行补充「按 token 降序」说明；管理面板端点表新增 `/api/models/search`。② 管理面板 `loadSettings` 模型映射列表按 token 降序排序（两入口同步，commit 7b6816b）。commit b4f0a76 已推送，部署验证通过。
- **2026-08-19（/v1/models 按 token 降序排序）**：两文件 `/v1/models` 端点改为按 token 上限从大到小排序（`customTokens[cfModel] || DEFAULT_MODEL_TOKENS[cfModel] || 0`），无 token 上限的模型（embedding/image/audio 等）排到最后。排序用临时 `_tokens` 字段，输出前 `.map(({ _tokens, ...rest }) => rest)` 剥离，不污染 OpenAI 格式。两文件同步，`node --check` 通过。
- **2026-08-19（模型目录核对 + getModelOwnedBy 改造）**：① 对照 CF 官方目录（2026-08-12，84 模型）核对 `DEFAULT_MODEL_MAP`：移除 8 个已弃用/不在目录/过时的模型（llama-3.1-8b、qwen1.5-14b、deepseek-coder-6.7b、codellama-34b、mixtral-8x7b、gemma-2-27b、phi-3-mini、deepseek-r1-distill-qwen-32b），替换为最新版本（llama-3.1-8b-instruct-fast、mistral-small-3.1-24b-instruct），新增 6 个模型（qwq-32b、granite-4.0-h-micro、llama-3.2-1b-instruct、llama-3.2-11b-vision-instruct、qwen3.8-27b、gemma-sea-lion-v4-27b-it）。② 改造 `getModelOwnedBy`：移除 `CF_OWNER_MAP` 前缀表，改为从 `@cf/` 路径自动提取 owner（如 `@cf/meta/xxx` → `meta`），新增模型无需维护前缀表。③ `DEFAULT_MODEL_TOKENS` 补全所有新模型 token 上限。④ AGENTS.md 新增 §6 CF 官方模型目录查询方法。两文件同步，`node --check` + grep 校验通过。
- **2026-08-19（低风险优化批量落地）**：按用户「性能优先、影响性能的不做」裁决落地 4 项（两入口同步）：① P2-8 `checkUsageLimit` 在 `threshold<=0`（限额关闭，默认）时短路返回，跳过 `getCachedSummary`+`getMonthlyUsage` 两次 KV 读（热路径性能提升）；② P2-6 `handleLandingPage`/`handleAdminPage` HTML 响应补 `X-Content-Type-Options: nosniff`+`X-Frame-Options: DENY`，csrf cookie 补 `Secure`；③ P2-7 `_worker.js` `/api/tokens/today` 注释「公开」→「需管理员认证」；④ P2-4 safeJsonBody 错误文案「Request body too large (max 10MB/32MB)」→「Invalid or missing JSON body」、status 413→400。`node --check` 两文件通过，grep 校验全绿。未做：P1-A（Cloudflare 自带限流，用户裁决跳过）、P1-B 主动刷新/口径统一、P1-C 熔断、P2-1/2/3/5（均影响性能或复杂度高）。
- **2026-08-19（决策落地 + 补充调研）**：① 按用户裁决落地：README 第41行「加密存储」改为「以明文存储」（删错误声称）；移除 `safeJsonBody` 大小限制（`src/index.js`/`_worker.js` 同步，函数改单参数，4 处显式传参调用点 `safeJsonBody(request,10/32)` 全部去参），`node --check` 通过、`safeJsonBody(request,` 为 0 处。② 用户裁决维持现状：P0-2 无 key 时 checkProxyAuth 开放、P1-4 两入口重复、P1-5 前端内嵌模板。③ 补充调研（只读）新增发现：P1-A 全站无限流/无登录爆破防护；P1-B 模式 B 限额拦截依赖过期 GraphQL 缓存（10min TTL，仅管理员打开用量页才刷新）且 Neurons/token 口径与模式 A（本地 token 统计）不一致；P1-C 模式 B failover+可恢复流无熔断可放大 8+ 倍上游推理、429 也重试。另有 P2-1~P2-8：KV read-modify-write 丢失更新、流式 token 中断漏记、非流式错误一律标 server_error、会话 token=sha256(密码) 静态无撤销、安全响应头缺失+csrf cookie 缺 Secure+第三方 CDN、`/api/tokens/today` 注释「公开」与实现矛盾、热路径固定 2 次 KV 读。CORS/XSS/CSRF/时序安全/日志脱敏已核查无问题。
- **2026-08-19（全量分析）**：对项目做全量优化点分析（未改代码）。结论：P0-1 账号 API Token / API Key 明文存 KV（README 声称加密但未实现）；P0-2 `checkProxyAuth` 无 key 时完全开放；P0-3 `safeJsonBody` 默认 128MB 且 Content-Length 缺失时绕过大小检查；P1-4 两入口 ~90% 重复代码（~5000 行）；P1-5 前端 ~2000 行内嵌模板字符串；P2 用量写 KV 频繁、KV 双重缓存。优点：timingSafeEqual、密码哈希缓存、错误分类/可恢复流、熔断/failover。
- **2026-08-19**：新增 `deepseek-v4-pro-0813`（`@cf/deepseek-ai/deepseek-v4-pro-0813`）与 `deepseek-v4-flash-0731`（`@cf/deepseek-ai/deepseek-v4-flash-0731`）两个模型映射，token 上限均 1048576，排在 `DEFAULT_MODEL_MAP` 的 `glm-5.2` 前。修复「自定义模型 Tokens 保存失效」：根因为 `createKVGetter` 60 秒闭包缓存导致保存后 `loadSettings` 重载返回旧值；改造 `createKVGetter` 返回函数挂载 `invalidate()` 方法，在 `saveModelTokens`/`saveCustomModelMap`/`saveUsageLimitsConfig`/`saveApiKeys`/`saveAccounts`（仅模式 B）写 KV 后调用对应 getter 的 `invalidate()`。两文件 `src/index.js` / `_worker.js` 同步。`node --check` 语法 OK，grep 对称性验证通过。创建本 `AGENTS.md`。

---

## 6. Cloudflare 官方模型目录查询与 @cf/ 模型筛选

> 更新 `DEFAULT_MODEL_MAP` 前必读：先核对 CF 官方目录，移除已弃用模型，替换为最新版本。

### 6.1 查询官方目录
- **URL**：`https://developers.cloudflare.com/workers-ai/models/`
- **方法**：用 `webfetch` 工具获取该页面（markdown 格式），页面列出所有 Workers AI 可用模型（约 80+ 个），含模型名称、提供商、任务类型、是否弃用。
- **更新频率**：CF 不定期更新目录，建议每 1-2 个月核对一次。

### 6.2 筛选 @cf/ 模型
- 目录中每个模型有一个 `@cf/<provider>/<model-name>` 格式的 ID。
- **只保留 `@cf/` 开头的模型**——这些是 Cloudflare 托管的模型，通过 Workers AI Binding 或 REST API 调用。
- 排除标记为 "Deprecated" 的模型。
- 排除 LoRA-only 模型（除非项目支持 LoRA）。

### 6.3 更新流程
1. `webfetch` 获取 `https://developers.cloudflare.com/workers-ai/models/`（markdown 格式）。
2. 提取所有 `@cf/` 模型，排除 Deprecated 和 LoRA-only。
3. 与当前 `DEFAULT_MODEL_MAP` 对比：
   - **移除**：已弃用或不在目录的模型。
   - **替换**：有最新版本的过时模型，替换为新版本。
   - **新增**：目录中新增的有价值模型。
4. 在 `DEFAULT_MODEL_TOKENS` 填上对应 token 上限（从模型详情页或目录描述获取 context window）。
5. 两文件同步修改（`src/index.js` + `_worker.js`），`node --check` + grep 校验。
6. `owned_by` 由 `getModelOwnedBy` 从 `@cf/` 路径自动提取（如 `@cf/meta/xxx` → `meta`），无需维护前缀表。