# cf-ai-gw

将 Cloudflare Workers AI（AI Binding）转成 OpenAI / Anthropic 兼容 API 的网关，自带可视化管理面板。**单账号、内部 RPC 调用**，无需 API Token，风控规避最佳。

> 模式 B（`_worker.js`，多账号 failover + REST API）已弃用，仍保留在仓库但不再维护。以下文档均针对当前默认的**模式 A**。

## 架构

```
客户端 ──Bearer/x-api-key──▶ Worker ──env.AI.run()──▶ Workers AI
                              │
                              ├─ KV：配置（cfg_api_keys/cfg_model_map/cfg_gpt_alias/cfg_model_tokens/cfg_limits）
                              │       用量汇总键（tokens_daily_/tokens_monthly_，TTL 8 天）
                              │       事件键（evt_<date>_<uuid>，TTL 8 天，请求数真源）
                              ├─ DurableObject KEY_COUNTER：每把 key 原子「检查并递增」已用次数（杜绝限次超卖）
                              └─ DurableObject USAGE_COUNTER：今日用量实时强一致计数（按 UTC 日期命名 usage:<date>）
```

**数据源分工**：

| 数据 | 存储 | 用途 |
|------|------|------|
| API key 限次计数 | DO `KEY_COUNTER` | 强一致原子「检查+递增」，并发不超卖 |
| 今日用量/请求数 | DO `USAGE_COUNTER` + KV `tokens_daily_` | 看板实时展示，`Math.max` 兜底（DO 冷启动偏低时取较大者） |
| 7 日历史走势 | KV `tokens_daily_<date>` × 7 | 单键 get，秒回 |
| 本月累计 | KV `tokens_monthly_<YYYY>_<MM>` | best-effort（并发覆盖可能略偏低） |
| 今日模型占比 | KV `tokens_daily_.models` | per-model requests + tokens，best-effort |
| 限额拦截读数 | DO + KV 汇总键 | 固定 ~4 个子请求，不随 evt_ 键数量线性增长 |

**定时任务**：`crons = ["0 0 * * *"]`，UTC 0 点每天清理 10 天前的 `usage:<date>` DO storage（看 7 日走势保留 10 天够用）。

## 快速部署

### 1. 部署 Worker

```bash
npx wrangler deploy
```

或 Dashboard → Workers & Pages → Import a repository → 选 `cf-ai-gw` 仓库 main 分支。

### 2. 配置绑定

`wrangler.toml` 已声明 KV / AI / 两个 DO / ADMIN_PASSWORD，`wrangler deploy` 会按 toml 部署。Dashboard 手工添加的绑定/变量（如自定义域）在 deploy 时可能被覆盖，diff 警告需仔细确认。

| 配置项 | 说明 |
|--------|------|
| KV 绑定（`KV`） | 存配置与用量 |
| AI 绑定（`AI`） | Workers AI Binding，模式 A 必需 |
| `ADMIN_PASSWORD` | 管理面板登录密码（`[vars]` 明文） |
| `KEY_COUNTER` / `USAGE_COUNTER` | 两个 Durable Object，自动随 migrations 创建 |

### 3. 创建 API Key

访问 `/admin` → 输入 `ADMIN_PASSWORD` 登录 → 「API Key」创建。

```bash
curl https://cf-ai-gw.<your-subdomain>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model": "glm-4.7-flash", "messages": [{"role": "user", "content": "你好"}]}'
```

## 数据看板

管理面板「数据看板」展示（口径为 **Token**，非 CF 计费 Neurons）：

- **今日用量**：大数字总量 + 上传/下载/速度 + 推理/缓存读 + 请求进度 + 节省成本
- **本月 Token 用量**：月初起累计
- **近 7 日消耗走势**：逐日 token 与请求数双曲线
- **今日模型消耗占比**：环形图 + 图例（悬浮显示 `X 次 · YK Tokens · Z%`）

> 今日请求数/用量来自 DO 强一致计数；历史走势来自 KV 汇总键（best-effort，并发覆盖可能略偏低）。

## 限额

**并发限额**（可调，看板「限额」页）：

| 配置 | 默认 | 说明 |
|------|------|------|
| 每模型默认并发上限 | 4 | 单模型 in-flight 上限，0=不限 |
| 全局并发上限 | 10 | 所有模型 in-flight 总上限，0=不限 |
| 按模型并发覆盖 | — | per-model 单独设并发，优先于默认 |

**请求次数限额已禁用**（`dailyRequestLimit`/`monthlyRequestLimit`/`threshold` 硬编码 0）。拦截路径仍保留 DO 快速路径实现作为未来安全网——重新开启只需改 `getUsageLimits` 三个 0 为读配置，不会再炸 5xx。Workers AI 免费额度按 Neurons 计，请求次数限额意义不大，并发够用。

## API 端点

### OpenAI 兼容

| 端点 | 方法 |
|------|------|
| `/v1/chat/completions` | POST |
| `/v1/completions` | POST |
| `/v1/responses` | POST |
| `/v1/embeddings` | POST |
| `/v1/models` / `/v1/models/{model}` | GET |
| `/v1/images/generations` | POST |
| `/v1/audio/transcriptions` / `/v1/audio/translations` / `/v1/audio/speech` | POST |

> `/v1/responses` 支持 OpenAI Responses 协议（新版 codex-cli 直连），含流式 SSE 事件状态机与 tool_calls 往返。

### Anthropic 兼容

| 端点 | 方法 |
|------|------|
| `/v1/messages` | POST |
| `/v1/messages/count_tokens` | POST |

### 管理面板

| 端点 | 说明 |
|------|------|
| `/admin` | 可视化管理面板 |
| `/api/auth/login` / `/api/auth/logout` | 登录/退出 |
| `/api/tokens/today` | 今日 Token 统计 |
| `/api/usage/summary` / `/api/accounts/usage` | 用量汇总/账号明细 |
| `/api/keys` | API Key 管理 |
| `/api/settings` | 模型映射/假名/Tokens 配置 |
| `/api/limits` | 限额配置 |
| `/api/models/search` | 搜索 CF 可用模型 |

## 可选环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `STRICT_MODEL_MATCH` | 关 | `true` 时无效模型名返回 404（默认回退兜底模型） |
| `OVERSIZE_TOKENS` | 按模型 | 请求过大 token 闸，0=关闭；优先级：显式配置 > 模型 token 上限 > 200000 |
| `GLOBAL_CONCURRENCY` | 10 | 全局并发上限 |
| `MAX_CONCURRENCY_PER_MODEL` | 4 | 每模型默认并发上限 |
| `CB_WINDOW_MS` / `CB_FAIL_THRESHOLD` / `CB_COOLDOWN_MS` | 10000 / 8 / 4000 | 熔断器窗口/阈值/冷却（毫秒） |
| `MODEL_DOWN_FAILS` / `MODEL_DOWN_AFTER_MS` | 3 / 60000 | 模型断供判死连续失败数/持续时间 |

## 内置模型

管理面板可自定义模型映射与 GPT 假名表。`/v1/models` 按 token 上限从大到小排序返回。完整列表见 `src/index.js` 的 `DEFAULT_MODEL_MAP`。

**文本生成**：deepseek-v4-pro-0813 / deepseek-v4-flash-0731 / glm-5.3 / glm-5.3-flash / glm-5.2 / glm-4.7-flash / kimi-k2.7-code / kimi-k2.6 / nemotron-3-120b-a12b / gemma-4-26b-a4b-it / llama-3.3-70b-instruct-fp8-fast / qwen3.8-27b / qwq-32b / qwen3-30b-a3b-fp8 / mistral-small-3.1-24b-instruct / gpt-oss-20b / gpt-oss-120b 等

**向量嵌入**：embeddinggemma-300m / qwen3-embedding-0.6b / bge-m3 / bge-large-en / bge-base-en-v1.5 / bge-reranker-base

**多模态**：llava-1.5-7b / moondream3.1-9B-A2B / flux-1-schnell（别名 flux）/ sdxl

**语音**：whisper / whisper-tiny-en / whisper-large-v3-turbo / nova-3（ASR）/ tts / aura-2-en（TTS）

## 发版说明

发布新版本时同时发 **GitHub Release（`/releases`）和 tag（`/tags`）**：

```bash
git tag -a vX.Y.Z -m "版本说明" <commit> && git push origin vX.Y.Z
# 再通过 API 创建 Release（引用已推送的 tag）
```

> 只推 tag 不会出现在 `/releases` 页面——Release 是独立对象，必须单独创建。