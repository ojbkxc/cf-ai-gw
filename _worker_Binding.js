/**
 * cf-ai-gw (Binding Edition)
 * 使用 Workers AI Binding 的单账号版本，用 env.AI.run() 替代 REST API 调用。
 * 无多账号 failover，无账号管理，直接使用 Worker 绑定的 AI 服务。
 */

// 用量限额配置（环境变量覆盖，未设置则用默认值）
const DEFAULT_DAILY_LIMIT = 10000;
const DEFAULT_MONTHLY_LIMIT = 100000;
const DEFAULT_USAGE_THRESHOLD = 0; // 0 表示关闭限额拦截（仅统计不拦截）

// 缓存与刷新常量
const MONTHLY_USAGE_TTL_SEC = 38 * 24 * 60 * 60;
const MODEL_CREATED_TS = 1686935000;

function safeJSONParse(raw, defaultVal) {
	if (!raw) return defaultVal;
	try { return JSON.parse(raw); } catch { return defaultVal; }
}

function getTodayStr() {
	return new Date().toISOString().split('T')[0];
}

const TOKEN_KV_TTL_SEC = 86400 * 2;    // KV 键保留 2 天
const MAX_TIMEOUT_RETRIES = 5;          // 流读取超时最大重试次数

// 获取 token 统计 KV 键名
function getTokenDailyKey() {
	return `tokens_daily_${getTodayStr()}`;
}

// 获取月度 token 统计 KV 键名
function getTokenMonthlyKey() {
	const d = new Date();
	return `tokens_monthly_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 累加 token 直接写入 KV（无内存缓冲，避免冷启动丢失）
async function accumulateTokens(env, ctx, { input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, durationSec = 0 }) {
	ctx.waitUntil((async () => {
		try {
			// 今日统计
			const dailyKey = getTokenDailyKey();
			const raw = await env.KV.get(dailyKey);
			const cur = raw ? JSON.parse(raw) : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, requests: 0, tokPerSecSum: 0, tokPerSecCount: 0 };
			cur.input += input;
			cur.output += output;
			cur.reasoning = (cur.reasoning || 0) + reasoning;
			cur.cacheRead = (cur.cacheRead || 0) + cacheRead;
			cur.cacheWrite = (cur.cacheWrite || 0) + cacheWrite;
			cur.requests += 1;
			if (durationSec > 0 && output > 0) {
				cur.tokPerSecSum = (cur.tokPerSecSum || 0) + Math.round(output / durationSec);
				cur.tokPerSecCount = (cur.tokPerSecCount || 0) + 1;
			}
			await env.KV.put(dailyKey, JSON.stringify(cur), { expirationTtl: TOKEN_KV_TTL_SEC });

			// 月度统计（累加模式）
			const monthlyKey = getTokenMonthlyKey();
			const monthlyRaw = await env.KV.get(monthlyKey);
			const monthly = monthlyRaw ? JSON.parse(monthlyRaw) : { input: 0, output: 0, reasoning: 0, requests: 0 };
			monthly.input += input;
			monthly.output += output;
			monthly.reasoning = (monthly.reasoning || 0) + reasoning;
			monthly.requests += 1;
			await env.KV.put(monthlyKey, JSON.stringify(monthly), { expirationTtl: 32 * 86400 });
		} catch (e) {
			console.error('Failed to accumulate tokens:', e?.message || e);
		}
	})());
}

// 从 usage 对象提取字段并累加 token 统计
function accumulateFromUsage(env, ctx, usage, requestStartTime) {
	if (!ctx || !usage) return;
	const pd = usage.prompt_tokens_details || {};
	accumulateTokens(env, ctx, {
		input: usage.prompt_tokens || 0,
		output: usage.completion_tokens || 0,
		reasoning: usage.reasoning_tokens || 0,
		cacheRead: pd.cached_tokens || usage.cache_read_tokens || 0,
		cacheWrite: usage.cache_write_tokens || 0,
		durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0,
	});
}

async function getTodayTokenStats(env) {
	const key = getTokenDailyKey();
	let kvData = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, requests: 0, tokPerSecSum: 0, tokPerSecCount: 0 };
	try {
		const raw = await env.KV.get(key);
		if (raw) kvData = JSON.parse(raw);
	} catch (e) { console.error('Failed to read token stats:', e?.message || e); }

	const avgTokPerSec = (kvData.tokPerSecCount || 0) > 0 ? Math.round((kvData.tokPerSecSum || 0) / (kvData.tokPerSecCount || 0)) : 0;

	return {
		input: kvData.input || 0,
		output: kvData.output || 0,
		reasoning: kvData.reasoning || 0,
		cacheRead: kvData.cacheRead || 0,
		cacheWrite: kvData.cacheWrite || 0,
		total: (kvData.input || 0) + (kvData.output || 0),
		requests: kvData.requests || 0,
		avgTokPerSec,
	};
}

// 找不到模型映射时的兜底模型
const DEFAULT_FALLBACK_MODEL = '@cf/zai-org/glm-4.7-flash';

// 默认模型映射表
const DEFAULT_MODEL_MAP = {
	// 对话 / 文本生成模型
	'glm-5.2': '@cf/zai-org/glm-5.2',
	'glm-4.7-flash': '@cf/zai-org/glm-4.7-flash',
	'kimi-k2.7-code': '@cf/moonshotai/kimi-k2.7-code',
	'kimi-k2.6': '@cf/moonshotai/kimi-k2.6',
	'gemma-4-26b-a4b-it': '@cf/google/gemma-4-26b-a4b-it',
	'nemotron-3-120b-a12b': '@cf/nvidia/nemotron-3-120b-a12b',
	'gpt-oss-20b': '@cf/openai/gpt-oss-20b',
	'gpt-oss-120b': '@cf/openai/gpt-oss-120b',
	'llama-3.1-8b': '@cf/meta/llama-3.1-8b-instruct',
	'deepseek-r1-distill-qwen-32b': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
	'qwen1.5-14b': '@cf/qwen/qwen1.5-14b-instruct',
	'deepseek-coder-6.7b': '@cf/deepseek-ai/deepseek-coder-6.7b-instruct',
	'llama-3.2-3b': '@cf/meta/llama-3.2-3b-instruct',
	'codellama-34b': '@cf/codellama/codellama-34b-instruct',
	'mixtral-8x7b': '@cf/mistral/mixtral-8x7b-instruct',
	'gemma-2-27b': '@cf/google/gemma-2-27b-it',
	'phi-3-mini': '@cf/microsoft/phi-3-mini-4k-instruct',

	// 向量嵌入（Embeddings）模型
	'embeddinggemma-300m': '@cf/google/embeddinggemma-300m',
	'qwen3-embedding-0.6b': '@cf/qwen/qwen3-embedding-0.6b',
	'bge-m3': '@cf/baai/bge-m3',
	'bge-large-en': '@cf/baai/bge-large-en-v1.5',

	// 多模态模型
	'llava-1.5-7b': '@cf/llava-hf/llava-1.5-7b-hf',
	'flux-1-schnell': '@cf/black-forest-labs/flux-1-schnell',
	'sdxl': '@cf/stabilityai/stable-diffusion-xl-base-1.0',

	// 语音识别（Whisper）模型
	'whisper': '@cf/openai/whisper',
	'whisper-tiny-en': '@cf/openai/whisper-tiny-en',
	'whisper-large-v3-turbo': '@cf/openai/whisper-large-v3-turbo',

	// 视觉模型
	'moondream3.1-9B-A2B': '@cf/moondream/moondream3.1-9B-A2B',

	// 向量嵌入（Embeddings）模型补充
	'bge-base-en-v1.5': '@cf/baai/bge-base-en-v1.5',

	// 文本转语音（TTS）模型
	'tts': '@cf/myshell-ai/tts'
};

// CF 模型前缀 → owned_by 映射表
const CF_OWNER_MAP = [
	['@cf/meta/', 'meta'], ['@cf/google/', 'google'], ['@cf/mistral/', 'mistral'],
	['@cf/microsoft/', 'microsoft'], ['@cf/openai/', 'openai'], ['@cf/nvidia/', 'nvidia'],
	['@cf/deepseek-ai/', 'deepseek'], ['@cf/qwen/', 'qwen'], ['@cf/zai-org/', 'zai-org'],
	['@cf/moonshotai/', 'moonshotai'], ['@cf/baai/', 'baai'], ['@cf/stabilityai/', 'stabilityai'],
	['@cf/black-forest-labs/', 'black-forest-labs'], ['@cf/codellama/', 'codellama'],
	['@cf/llava-hf/', 'llava-hf'], ['@cf/internlm/', 'internlm'],
	['@cf/myshell-ai/', 'myshell-ai'], ['@cf/moondream/', 'moondream'],
];

function getModelOwnedBy(cfModel, id) {
	let ownedBy = 'system';
	for (const [prefix, owner] of CF_OWNER_MAP) {
		if (cfModel.startsWith(prefix)) { ownedBy = owner; break; }
	}
	if (ownedBy === 'system' && id.includes('embedding')) ownedBy = 'openai';
	return ownedBy;
}

export default {
	async fetch(request, env, ctx) {
		try {
			// 1. 检查是否绑定了 KV 存储
			if (!env.KV) {
				const url = new URL(request.url);
				if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
					return jsonError('KV storage not configured. Please bind a KV namespace named \'KV\' in your Pages project settings.', 503, 'server_error');
				}
				return new Response('KV storage not configured. Please bind a KV namespace named \'KV\' in your Pages project settings.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' }
				});
			}

			// 2. 检查是否配置了 ADMIN_PASSWORD 环境变量
			if (!env.ADMIN_PASSWORD) {
				const url = new URL(request.url);
				if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
					return jsonError('ADMIN_PASSWORD not configured. Please set this environment variable in your Pages project settings.', 503, 'server_error');
				}
				return new Response('ADMIN_PASSWORD not configured. Please set this environment variable in your Pages project settings.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' }
				});
			}

			// 3. 检查是否绑定了 AI binding
			if (!env.AI) {
				const url = new URL(request.url);
				if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
					return jsonError('AI binding not configured. Please bind a Workers AI binding named \'AI\' in your Pages project settings.', 503, 'server_error');
				}
				return new Response('AI binding not configured. Please bind a Workers AI binding named \'AI\' in your Pages project settings.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' }
				});
			}

			// 处理跨域预检请求（OPTIONS）
			if (request.method === 'OPTIONS') {
				const reqUrl = new URL(request.url);
				const isApiPath = reqUrl.pathname.startsWith('/api/');
				const origin = request.headers.get('Origin');
				const allowOrigin = (isApiPath && origin && origin === reqUrl.origin) ? origin
					: (isApiPath && (!origin || origin !== reqUrl.origin)) ? 'null'
					: '*';
				return new Response(null, {
					headers: {
						'Access-Control-Allow-Origin': allowOrigin,
						'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
						...(isApiPath && allowOrigin !== 'null' ? { 'Vary': 'Origin' } : {})
					}
				});
			}

			const url = new URL(request.url);

			// 4. OpenAI 兼容的代理接口（/v1/ 开头）
			if (url.pathname.startsWith('/v1/')) {
				const response = await handleV1Proxy(request, env, ctx);
				return addCORSHeaders(response, request);
			}

			// 5. 后台管理面板的 API 接口（/api/ 开头）
			if (url.pathname.startsWith('/api/')) {
				const response = await handleDashboardApi(request, env, ctx);
				return addCORSHeaders(response, request);
			}

			// 6. 后台管理面板页面
			if (url.pathname === '/admin' || url.pathname === '/admin/') {
				const isLoggedIn = await checkAdminAuth(request, env);
				if (isLoggedIn) {
					return handleAdminPage(request, env, ctx);
				} else {
					return new Response(null, {
						status: 302,
						headers: { 'Location': '/' }
					});
				}
			}

			// 7. 首页 / 登录页
			if (url.pathname === '/') {
				return handleLandingPage(request, env, ctx);
			}

			// robots.txt
			if (url.pathname === '/robots.txt') {
				return new Response('User-agent: *\nDisallow: /', {
					headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Request-Id': generateRequestId() }
				});
			}

			// 8. 其他路径一律返回 404
			return new Response('404 Not Found', { status: 404, headers: { 'X-Request-Id': generateRequestId() } });
		} catch (e) {
			console.error(`Unhandled error: ${e?.message || e}`);
			return jsonError('Internal Server Error', 500, 'server_error');
		}
	}
};

// ===== 工具函数 =====

function addCORSHeaders(response, request) {
	const newResponse = new Response(response.body, response);
	if (!newResponse.headers.has('X-Request-Id')) {
		newResponse.headers.set('X-Request-Id', generateRequestId());
	}
	newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
	newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
	try {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/api/')) {
			const origin = request.headers.get('Origin');
			if (origin && origin === url.origin) {
				newResponse.headers.set('Access-Control-Allow-Origin', origin);
				newResponse.headers.set('Vary', 'Origin');
			}
		} else {
			newResponse.headers.set('Access-Control-Allow-Origin', '*');
		}
	} catch (_) {
		newResponse.headers.set('Access-Control-Allow-Origin', '*');
	}
	return newResponse;
}

async function sha256(message) {
	const msgBuffer = new TextEncoder().encode(message);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// KV 工具函数
function createKVGetter(kvKey, defaultValue) {
	let _promise = null;
	return async function(env) {
		if (_promise) return _promise;
		_promise = (async () => {
			const raw = await env.KV.get(kvKey, { cacheTtl: 60 });
			return safeJSONParse(raw, defaultValue);
		})();
		try { return await _promise; } finally { /* keep _promise for same-request dedup */ }
	};
}
const getApiKeys = createKVGetter('cfg_api_keys', []);
const getCustomModelMap = createKVGetter('cfg_model_map', {});
const getUsageLimitsConfig = createKVGetter('cfg_limits', {});

async function saveUsageLimitsConfig(env, limits) {
	const existing = await getUsageLimitsConfig(env);
	const merged = { ...existing, ...limits };
	await env.KV.put('cfg_limits', JSON.stringify(merged));
}

async function saveCustomModelMap(env, map) {
	await env.KV.put('cfg_model_map', JSON.stringify(map));
}

async function saveApiKeys(env, keys) {
	await env.KV.put('cfg_api_keys', JSON.stringify(keys));
}

const COOKIE_TOKEN_RE = /admin_token=([^;]+)/;

function maskTokenKey(key) {
	if (!key) return '';
	if (key.length <= 4) return '*'.repeat(key.length);
	if (key.length <= 8) return key.slice(0, 2) + '****' + key.slice(-2);
	return key.slice(0, 4) + '**********' + key.slice(-4);
}

function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

// 缓存 ADMIN_PASSWORD 的 SHA-256 哈希
let _cachedAdminHash = null;
let _cachedAdminPassword = null;

async function checkAdminAuth(request, env) {
	const cookies = request.headers.get('Cookie') || '';
	const cookieMatch = cookies.match(COOKIE_TOKEN_RE);
	let token = cookieMatch ? cookieMatch[1] : null;

	if (!token) {
		const authHeader = request.headers.get('Authorization');
		if (authHeader && authHeader.startsWith('Bearer ')) {
			token = authHeader.substring(7);
		}
	}

	if (!token) return false;

	const expectedPassword = env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD.trim() : '';

	if (!expectedPassword) return false;

	if (_cachedAdminHash === null || _cachedAdminPassword !== expectedPassword) {
		_cachedAdminHash = await sha256(expectedPassword);
		_cachedAdminPassword = expectedPassword;
	}
	return timingSafeEqual(token, _cachedAdminHash);
}

async function checkProxyAuth(request, env) {
	const apiKeys = await getApiKeys(env);
	if (apiKeys.length === 0) {
		return true;
	}

	const xApiKey = request.headers.get('x-api-key');
	if (xApiKey && apiKeys.some(k => timingSafeEqual(k.key, xApiKey))) {
		return true;
	}

	const authHeader = request.headers.get('Authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		const token = authHeader.substring(7);
		return apiKeys.some(k => timingSafeEqual(k.key, token));
	}

	return false;
}

function jsonError(message, status = 500, type = 'server_error', code = null, param = null) {
	const errBody = { error: { message, type } };
	if (code !== null) errBody.error.code = code;
	if (param !== null) errBody.error.param = param;
	const reqId = generateRequestId();
	return new Response(JSON.stringify(errBody), {
		status,
		headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId }
	});
}

function methodNotAllowed(allowedMethods) {
	const allow = Array.isArray(allowedMethods) ? allowedMethods.join(', ') : allowedMethods;
	const reqId = generateRequestId();
	return new Response(JSON.stringify({
		error: { message: `Method not allowed. Allowed: ${allow}`, type: 'invalid_request_error', code: 'method_not_allowed' }
	}), {
		status: 405,
		headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, 'Allow': allow }
	});
}

function anthropicError(message, status = 400) {
	return new Response(JSON.stringify({
		type: 'error',
		error: { type: 'invalid_request_error', message }
	}), { status, headers: { 'Content-Type': 'application/json' } });
}

function generateRequestId() {
	const chars = 'abcdef0123456789';
	let id = 'req_';
	for (let i = 0; i < 24; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

function readWithTimeout(reader, timeoutMs, { cancelOnTimeout = false } = {}) {
	let timer;
	const read = reader.read();
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			if (cancelOnTimeout) { try { reader.cancel(); } catch (_) {} }
			reject(new Error(cancelOnTimeout ? 'Initial read timed out' : 'Stream read timed out'));
		}, timeoutMs);
	});
	return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

function getEnvNum(env, key, defaultVal, parseFn) {
	const raw = env[key];
	if (raw == null || raw === '') return defaultVal;
	const val = parseFn(raw);
	return isNaN(val) ? defaultVal : val;
}

// 读取日/月限额和阈值配置（优先级：环境变量 > KV > 默认值）
async function getUsageLimits(env) {
	const kvLimits = await getUsageLimitsConfig(env);

	return {
		dailyLimit: getEnvNum(env, 'DAILY_LIMIT', kvLimits.dailyLimit ?? DEFAULT_DAILY_LIMIT, parseInt),
		monthlyLimit: getEnvNum(env, 'MONTHLY_LIMIT', kvLimits.monthlyLimit ?? DEFAULT_MONTHLY_LIMIT, parseInt),
		threshold: getEnvNum(env, 'USAGE_THRESHOLD', kvLimits.threshold ?? DEFAULT_USAGE_THRESHOLD, parseFloat)
	};
}

function getMonthlyUsageKey() {
	const now = new Date();
	return `usage_monthly_${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getMonthlyUsage(env) {
	const raw = await env.KV.get(getMonthlyUsageKey());
	return raw ? parseInt(raw, 10) : 0;
}

// 用量限额检查（简化版：从 token 统计 KV 获取用量）
async function checkUsageLimit(env) {
	const { dailyLimit, monthlyLimit, threshold } = await getUsageLimits(env);

	// 当日用量从 token 统计 KV 获取
	const stats = await getTodayTokenStats(env);
	const dailyUsage = stats.total;

	const monthlyUsage = await getMonthlyUsage(env);

	let result;
	if (threshold <= 0) {
		result = { allowed: true, dailyUsage, dailyLimit, monthlyUsage, monthlyLimit, threshold };
	} else {
		const dailyExceeded = dailyUsage >= dailyLimit * threshold;
		const monthlyExceeded = monthlyUsage >= monthlyLimit * threshold;

		if (dailyExceeded || monthlyExceeded) {
			const reason = dailyExceeded
				? `Daily usage (${dailyUsage}/${dailyLimit}) exceeds ${Math.round(threshold * 100)}% threshold`
				: `Monthly usage (${monthlyUsage}/${monthlyLimit}) exceeds ${Math.round(threshold * 100)}% threshold`;
			result = { allowed: false, reason, dailyUsage, dailyLimit, monthlyUsage, monthlyLimit, threshold };
		} else {
			result = { allowed: true, dailyUsage, dailyLimit, monthlyUsage, monthlyLimit, threshold };
		}
	}

	return result;
}

// ===== Workers AI Binding 调用函数 =====

async function callBindingChat(cfModel, cfPayload, env, stream) {
	try {
		if (stream) {
			const inputs = { ...cfPayload, stream: true };
			const resp = await env.AI.run(cfModel, inputs, { returnRawResponse: true });
			if (!resp.ok) {
				const errText = await resp.text();
				return { success: false, status: resp.status, error: `AI Binding error (${resp.status}): ${errText}` };
			}
			if (!resp.body) {
				return { success: false, status: 502, error: 'AI Binding returned empty response body' };
			}
			return { success: true, status: resp.status, stream: resp.body };
		}
		const result = await env.AI.run(cfModel, cfPayload);
		return { success: true, status: 200, data: result };
	} catch (e) {
		return { success: false, status: 502, error: `AI Binding error: ${e.message}` };
	}
}

// ===== 模型名解析 =====
async function resolveModelName(model, env) {
	if (!model) return { cfModel: DEFAULT_FALLBACK_MODEL, isFallback: true };
	if (model.startsWith('@cf/')) return { cfModel: model, isFallback: false };
	const customMap = await getCustomModelMap(env);
	const combinedMap = { ...DEFAULT_MODEL_MAP, ...customMap };
	const mapped = combinedMap[model];
	if (mapped) return { cfModel: mapped, isFallback: false };
	return { cfModel: DEFAULT_FALLBACK_MODEL, isFallback: true };
}

// ===== handleV1Proxy =====
async function handleV1Proxy(request, env, ctx) {
	const url = new URL(request.url);

	if (!await checkProxyAuth(request, env)) {
		if (url.pathname === '/v1/messages') {
			return new Response(JSON.stringify({
				type: 'error',
				error: {
					type: 'authentication_error',
					message: 'Invalid x-api-key or Authorization header.'
				}
			}), { status: 401, headers: { 'Content-Type': 'application/json', 'X-Request-Id': generateRequestId() } });
		}
		return jsonError("Incorrect or missing API key. Configure keys in the dashboard.", 401, "invalid_request_error", "invalid_api_key");
	}

	const limitCheck = await checkUsageLimit(env);
	if (!limitCheck.allowed) {
		const msg = `Request blocked: ${limitCheck.reason}. Please check your usage dashboard.`;

		if (url.pathname === '/v1/messages') {
			return new Response(JSON.stringify({
				type: 'error',
				error: { type: 'quota_exceeded', message: msg }
			}), { status: 429, headers: { 'Content-Type': 'application/json', 'X-Request-Id': generateRequestId() } });
		}
		return jsonError(msg, 429, 'quota_exceeded');
	}

	if (url.pathname === '/v1/models' && request.method === 'GET') {
		const customMap = await getCustomModelMap(env);
		const combinedMap = { ...DEFAULT_MODEL_MAP, ...customMap };

		const modelsData = Object.keys(combinedMap).map(id => {
			const cfModel = combinedMap[id] || '';
			const ownedBy = getModelOwnedBy(cfModel, id);
			return {
				id,
				object: 'model',
				created: MODEL_CREATED_TS,
				owned_by: ownedBy
			};
		});

		return new Response(JSON.stringify({
			object: 'list',
			data: modelsData
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	if (url.pathname.startsWith('/v1/models/') && request.method === 'GET') {
		const modelId = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
		if (!modelId) {
			return jsonError("Model ID is required", 400, "invalid_request_error");
		}

		const customMap = await getCustomModelMap(env);
		const combinedMap = { ...DEFAULT_MODEL_MAP, ...customMap };
		const cfModel = combinedMap[modelId];

		if (!cfModel) {
			return jsonError(`Model '${modelId}' not found`, 404, "model_not_found");
		}

		const ownedBy = getModelOwnedBy(cfModel, modelId);

		return new Response(JSON.stringify({
			id: modelId,
			object: 'model',
			created: MODEL_CREATED_TS,
			owned_by: ownedBy
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	if ((url.pathname === '/v1/chat/completions' || url.pathname === '/v1/completions') && request.method === 'POST') {
		return handleCompletions(request, env, ctx, url.pathname);
	}

	if (url.pathname === '/v1/messages' && request.method === 'POST') {
		return handleMessages(request, env, ctx);
	}

	if (url.pathname === '/v1/embeddings' && request.method === 'POST') {
		return handleEmbeddings(request, env, ctx);
	}

	if (url.pathname === '/v1/images/generations' && request.method === 'POST') {
		return handleImageGenerations(request, env, ctx);
	}

	if (url.pathname === '/v1/audio/transcriptions' && request.method === 'POST') {
		return handleAudioTranscribe(request, env, ctx, false);
	}

	if (url.pathname === '/v1/audio/translations' && request.method === 'POST') {
		return handleAudioTranscribe(request, env, ctx, true);
	}

	if (url.pathname === '/v1/audio/speech' && request.method === 'POST') {
		return handleAudioSpeech(request, env, ctx);
	}

	if (url.pathname === '/v1/messages/count_tokens' && request.method === 'POST') {
		return handleCountTokens(request, env);
	}

	// 405 方法校验
	const methodRoutes = {
		'/v1/models': ['GET'],
		'/v1/chat/completions': ['POST'],
		'/v1/completions': ['POST'],
		'/v1/messages': ['POST'],
		'/v1/embeddings': ['POST'],
		'/v1/images/generations': ['POST'],
		'/v1/audio/transcriptions': ['POST'],
		'/v1/audio/translations': ['POST'],
		'/v1/audio/speech': ['POST'],
		'/v1/messages/count_tokens': ['POST'],
	};
	if (methodRoutes[url.pathname]) {
		return methodNotAllowed(methodRoutes[url.pathname]);
	}
	if (url.pathname.startsWith('/v1/models/')) {
		return methodNotAllowed(['GET']);
	}

	return jsonError(`Path not found: ${url.pathname}`, 404, "invalid_request_error");
}

// ===== handleCompletions =====
async function handleCompletions(request, env, ctx, pathname) {
	const body = await safeJsonBody(request, 10);
	if (!body) return jsonError("Request body too large (max 10MB)", 413, "invalid_request_error");

	const requestStartTime = Date.now();

	const { model, messages, prompt, stream } = body;

	if (pathname === '/v1/chat/completions' && !messages) {
		return jsonError("messages field is required", 400, "invalid_request_error");
	}
	if (pathname === '/v1/completions' && !prompt) {
		return jsonError("prompt field is required", 400, "invalid_request_error");
	}

	const { cfModel, isFallback } = await resolveModelName(model, env);
	const fallbackWarning = isFallback ? `Model "${model}" not found in mapping, fell back to ${cfModel}` : null;

	const cfPayload = {
		model: cfModel,
		messages: pathname === '/v1/chat/completions' ? messages : [{ role: 'user', content: prompt }],
		stream: !!stream,
	};

	const passthroughFields = [
		'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'n',
		'stop', 'presence_penalty', 'frequency_penalty',
		'logprobs', 'top_logprobs', 'seed', 'user',
		'tools', 'tool_choice', 'parallel_tool_calls',
		'response_format', 'stream_options',
		'reasoning_effort', 'chat_template_kwargs',
	];
	for (const field of passthroughFields) {
		if (body[field] !== undefined) cfPayload[field] = body[field];
	}

	if (stream && !cfPayload.stream_options) {
		cfPayload.stream_options = { include_usage: true };
	}

	const result = await callBindingChat(cfModel, cfPayload, env, stream);

	if (!result.success) {
		return jsonError(result.error, result.status || 502, "server_error");
	}

	if (stream) {
		// For Binding streaming, we get a ReadableStream directly. Wrap it in passthroughStream for SSE processing.
		return streamResponse(
			passthroughStream(result.stream, model, pathname === '/v1/completions', env, ctx, requestStartTime),
			fallbackWarning
		);
	}
	const cfJson = result.data;
	if (cfJson.model !== undefined) cfJson.model = model;
	accumulateFromUsage(env, ctx, cfJson.usage, requestStartTime);
	if (pathname === '/v1/completions') {
		const textChoices = (cfJson.choices || []).map(c => ({
			text: c.message?.content || '',
			index: c.index ?? 0,
			logprobs: c.logprobs ?? null,
			finish_reason: c.finish_reason || 'stop'
		}));
		return jsonResponse({
			id: cfJson.id,
			object: 'text_completion',
			created: cfJson.created,
			model: cfJson.model,
			choices: textChoices,
			usage: cfJson.usage
		}, fallbackWarning);
	}
	return jsonResponse(cfJson, fallbackWarning);
}

// ===== Anthropic Messages API → OpenAI Chat Completions 格式转换 =====
function convertAnthropicToOpenAI(anthropicBody) {
	const openaiBody = {};

	openaiBody.model = anthropicBody.model;
	if (anthropicBody.max_tokens !== undefined) openaiBody.max_tokens = anthropicBody.max_tokens;
	if (anthropicBody.stream !== undefined) openaiBody.stream = anthropicBody.stream;
	if (anthropicBody.temperature !== undefined) openaiBody.temperature = anthropicBody.temperature;
	if (anthropicBody.top_p !== undefined) openaiBody.top_p = anthropicBody.top_p;
	if (anthropicBody.stop_sequences !== undefined) openaiBody.stop = anthropicBody.stop_sequences;
	if (anthropicBody.thinking?.type === 'enabled') openaiBody.reasoning_effort = 'high';
	if (anthropicBody.metadata && anthropicBody.metadata.user_id) openaiBody.user = anthropicBody.metadata.user_id;

	const openaiMessages = [];

	if (anthropicBody.system) {
		let systemContent = '';
		if (typeof anthropicBody.system === 'string') {
			systemContent = anthropicBody.system;
		} else if (Array.isArray(anthropicBody.system)) {
			for (const block of anthropicBody.system) {
				if (block.type === 'text' && block.text) {
					systemContent += block.text + '\n';
				}
			}
			systemContent = systemContent.trim();
		}
		if (systemContent) {
			openaiMessages.push({ role: 'system', content: systemContent });
		}
	}

	for (const msg of anthropicBody.messages) {
		const role = msg.role;
		const content = msg.content;

		if (typeof content === 'string') {
			openaiMessages.push({ role, content });
		} else if (Array.isArray(content)) {

			if (role === 'assistant') {
				let textContent = '';
				const toolCalls = [];

				for (const block of content) {
					if (block.type === 'text') {
						textContent += block.text || '';
					} else if (block.type === 'tool_use') {
						toolCalls.push({
							id: block.id,
							type: 'function',
							function: {
								name: block.name,
								arguments: JSON.stringify(block.input || {})
							}
						});
					}
				}

				const assistantMsg = { role: 'assistant', content: textContent || null };
				if (toolCalls.length > 0) {
					assistantMsg.tool_calls = toolCalls;
				}
				openaiMessages.push(assistantMsg);
				continue;
			}

			if (role === 'user') {
				for (const block of content) {
					if (block.type === 'tool_result') {
						let resultContent = '';
						if (typeof block.content === 'string') {
							resultContent = block.content;
						} else if (Array.isArray(block.content)) {
							for (const c of block.content) {
								if (c.type === 'text' && c.text) {
									resultContent += c.text;
								}
							}
						}
						const toolMsg = {
							role: 'tool',
							tool_call_id: block.tool_use_id,
							content: resultContent
						};
						if (block.name) toolMsg.name = block.name;
						openaiMessages.push(toolMsg);
					}
				}

				const openaiContentParts = [];
				for (const block of content) {
					if (block.type === 'text') {
						openaiContentParts.push({ type: 'text', text: block.text || '' });
					} else if (block.type === 'image') {
						const source = block.source || {};
						let imageUrl = '';
						if (source.type === 'url' && source.url) {
							imageUrl = source.url;
						} else if (source.data) {
							const mediaType = source.media_type || 'image/png';
							imageUrl = `data:${mediaType};base64,${source.data}`;
						}
						if (imageUrl) {
							openaiContentParts.push({
								type: 'image_url',
								image_url: { url: imageUrl }
							});
						}
					}
				}

				if (openaiContentParts.length > 0) {
					openaiMessages.push({ role: 'user', content: openaiContentParts });
				}
				continue;
			}

			const openaiContentParts = [];
			for (const block of content) {
				if (block.type === 'text') {
					openaiContentParts.push({ type: 'text', text: block.text || '' });
				}
			}
			if (openaiContentParts.length > 0) {
				openaiMessages.push({ role, content: openaiContentParts });
			}
		}
	}

	const firstNonSystemMsg = openaiMessages.find(m => m.role !== 'system');
	if (firstNonSystemMsg && firstNonSystemMsg.role === 'assistant') {
		const systemCount = openaiMessages.filter(m => m.role === 'system').length;
		openaiMessages.splice(systemCount, 0, {
			role: 'user',
			content: ' '
		});
	}

	openaiBody.messages = openaiMessages;

	if (anthropicBody.tools && Array.isArray(anthropicBody.tools)) {
		openaiBody.tools = anthropicBody.tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description || '',
				parameters: tool.input_schema || {}
			}
		}));
	}

	if (anthropicBody.tool_choice) {
		const tc = anthropicBody.tool_choice;
		const type = typeof tc === 'string' ? tc : tc.type;
		if (type === 'auto') {
			openaiBody.tool_choice = 'auto';
		} else if (type === 'any') {
			openaiBody.tool_choice = 'required';
		} else if (type === 'none') {
			openaiBody.tool_choice = 'none';
		} else if (type === 'tool' && tc.name) {
			openaiBody.tool_choice = { type: 'function', function: { name: tc.name } };
		}
	}

	return openaiBody;
}

// ===== OpenAI Chat Completion 响应 → Anthropic Messages 格式转换 =====
function convertOpenAIToAnthropic(openaiResponse, originalModel) {
	const choice = openaiResponse.choices?.[0] || {};
	const message = choice.message || {};

	const anthropicResponse = {
		id: `msg_${crypto.randomUUID()}`,
		type: 'message',
		role: 'assistant',
		content: [],
		model: originalModel,
		stop_reason: null,
		stop_sequence: null,
		usage: {
			input_tokens: openaiResponse.usage?.prompt_tokens || 0,
			output_tokens: openaiResponse.usage?.completion_tokens || 0,
			cache_creation_input_tokens: openaiResponse.usage?.cache_creation_input_tokens || 0,
			cache_read_input_tokens: (openaiResponse.usage?.prompt_tokens_details?.cached_tokens ?? openaiResponse.usage?.cache_read_input_tokens ?? 0)
		}
	};

	if (message.reasoning_content) {
		anthropicResponse.content.push({
			type: 'thinking',
			thinking: message.reasoning_content
		});
	}

	if (message.content) {
		anthropicResponse.content.push({
			type: 'text',
			text: message.content
		});
	}

	if (message.tool_calls && Array.isArray(message.tool_calls)) {
		for (const tc of message.tool_calls) {
			let inputObj = {};
			try {
				const args = tc.function?.arguments;
				inputObj = typeof args === 'string' ? JSON.parse(args) : (args || {});
			} catch (_) {
				inputObj = {};
			}
			anthropicResponse.content.push({
				type: 'tool_use',
				id: tc.id,
				name: tc.function?.name || '',
				input: inputObj
			});
		}
	}

	const finishReason = choice.finish_reason;
	if (finishReason === 'stop') {
		anthropicResponse.stop_reason = 'end_turn';
	} else if (finishReason === 'tool_calls') {
		anthropicResponse.stop_reason = 'tool_use';
	} else if (finishReason === 'length') {
		anthropicResponse.stop_reason = 'max_tokens';
	} else {
		anthropicResponse.stop_reason = finishReason || 'end_turn';
	}

	return anthropicResponse;
}

// ===== OpenAI 错误响应 → Anthropic 错误格式转换 =====
function convertOpenAIErrorToAnthropic(openaiError) {
	return {
		type: 'error',
		error: {
			type: 'api_error',
			message: openaiError?.error?.message || openaiError?.message || 'Unknown error'
		}
	};
}

// ===== handleMessages =====
async function handleMessages(request, env, ctx) {
	const requestStartTime = Date.now();
	const anthropicBody = await safeJsonBody(request, 32);
	if (!anthropicBody) return anthropicError('Request body too large (max 32MB).');

	if (!anthropicBody.messages || !Array.isArray(anthropicBody.messages)) {
		return anthropicError('messages field is required and must be an array.');
	}

	const model = anthropicBody.model;
	const { cfModel, isFallback } = await resolveModelName(model, env);
	const fallbackWarning = isFallback ? `Model "${model}" not found in mapping, fell back to ${cfModel}` : null;

	const openaiBody = convertAnthropicToOpenAI(anthropicBody);
	openaiBody.model = cfModel;

	const stream = !!anthropicBody.stream;
	if (stream) {
		openaiBody.stream_options = { include_usage: true };
	}

	const result = await callBindingChat(cfModel, openaiBody, env, stream);

	if (!result.success) {
		let errorDetail;
		try {
			if (result.error && result.error.includes('AI Binding error')) {
				const match = result.error.match(/AI Binding error \(\d+\): (.+)/);
				if (match) {
					errorDetail = JSON.parse(match[1]);
				}
			}
		} catch (_) { console.error('Failed to parse error detail:', _?.message || _); }

		const anthropicErr = convertOpenAIErrorToAnthropic(
			errorDetail || { message: result.error }
		);
		return new Response(JSON.stringify(anthropicErr), {
			status: result.status || 502,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (stream) {
		return streamResponse(
			anthropicStreamTransform(result.stream, model, anthropicBody.messages, env, ctx, requestStartTime),
			fallbackWarning
		);
	}
	const openaiResponse = result.data;
	accumulateFromUsage(env, ctx, openaiResponse.usage, requestStartTime);
	return jsonResponse(convertOpenAIToAnthropic(openaiResponse, model), fallbackWarning);
}

// ===== Anthropic SSE 流式转换：OpenAI SSE → Anthropic SSE =====
function anthropicStreamTransform(upstreamBody, modelName, originalMessages, env, ctx, requestStartTime) {
	const reader = upstreamBody.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let messageId = `msg_${crypto.randomUUID()}`;
	let contentBlockIndex = -1;
	let currentToolCallId = null;
	let currentToolName = null;
	let currentToolArgs = '';
	let streamStarted = false;
	let blockStopSent = false;
	let finalEventSent = false;
	let thinkingBlockActive = false;
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;

	let enqueuedAny = false;
	let pingInterval = null;

	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`));
			pingInterval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`));
				} catch (_) { /* controller 已关闭 */ }
			}, 10000);
		},
		async pull(controller) {
			enqueuedAny = false;
			const originalEnqueue = controller.enqueue.bind(controller);
			controller.enqueue = (chunk) => {
				enqueuedAny = true;
				originalEnqueue(chunk);
			};
			let timeoutRetries = 0;

			try {
				while (true) {
					let result;
					try {
						result = await readWithTimeout(reader, 120000);
					} catch (e) {
						if (e.message === 'Stream read timed out' && timeoutRetries < MAX_TIMEOUT_RETRIES) {
							timeoutRetries++;
							await new Promise(r => setTimeout(r, Math.min(1000 * timeoutRetries, 5000)));
							continue;
						}
						throw e;
					}
					timeoutRetries = 0;
					if (result.done) {
						if (buffer.trim()) {
							buffer = processLines(buffer, controller);
						}
						if (!finalEventSent) {
							sendFinalEvent(controller);
						}
						controller.close();
						if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
						break;
					}

					buffer += decoder.decode(result.value, { stream: true });
					buffer = processLines(buffer, controller);

					if (buffer.indexOf('\n') === -1) {
						if (enqueuedAny) {
							break;
						}
					}
				}
			} catch (e) {
				console.error(`anthropicStreamTransform upstream error: ${e?.message || e}`);
				try {
					if (buffer.trim()) {
						buffer = processLines(buffer, controller);
					}
					if (!finalEventSent) {
						sendFinalEvent(controller);
					}
				} catch (e2) { console.error('anthropicStreamTransform secondary error:', e2?.message || e2); }
				try { controller.close(); } catch (_) { }
			}
		},
		cancel() {
			if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
			return reader.cancel();
		},
	});

	function processLines(data, controller) {
		const lines = data.split('\n');
		const remaining = lines.pop();

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (trimmed.startsWith('data: ')) {
				const dataStr = trimmed.slice(6);
				if (dataStr === '[DONE]') {
					sendFinalEvent(controller);
					continue;
				}

				try {
					const chunk = JSON.parse(dataStr);
					const choice = chunk.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta || {};

					if (chunk.usage) {
						inputTokens = chunk.usage.prompt_tokens || 0;
						outputTokens = chunk.usage.completion_tokens || 0;
						reasoningTokens = chunk.usage.reasoning_tokens || 0;
						cacheReadTokens = (chunk.usage.prompt_tokens_details?.cached_tokens || chunk.usage.cache_read_tokens || 0);
						cacheWriteTokens = chunk.usage.cache_write_tokens || 0;
					}

					if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
						if (!streamStarted) {
							sendMessageStart(controller);
							streamStarted = true;
						}

						for (const tc of delta.tool_calls) {
							if (tc.id) {
								if (currentToolCallId) {
									sendContentBlockStop(controller);
									blockStopSent = true;
								}
								currentToolCallId = tc.id;
								currentToolName = tc.function?.name || '';
								currentToolArgs = '';
								contentBlockIndex++;
								blockStopSent = false;

								sendContentBlockStart(controller, 'tool_use');
							}

							if (tc.function?.arguments) {
								currentToolArgs += tc.function.arguments;
								sendToolUseDelta(controller, tc.function.arguments);
							}
						}
					} else if (delta.reasoning_content) {
						if (!streamStarted) {
							sendMessageStart(controller);
							streamStarted = true;
						}
						if (!thinkingBlockActive) {
							contentBlockIndex++;
							sendContentBlockStart(controller, 'thinking');
							thinkingBlockActive = true;
							blockStopSent = false;
						}
						sendThinkingDelta(controller, delta.reasoning_content);
					} else if (delta.content) {
						if (!streamStarted) {
							sendMessageStart(controller);
							contentBlockIndex++;
							sendContentBlockStart(controller, 'text');
							streamStarted = true;
							blockStopSent = false;
						}

						if (thinkingBlockActive) {
							sendContentBlockStop(controller);
							blockStopSent = true;
							thinkingBlockActive = false;
							contentBlockIndex++;
							sendContentBlockStart(controller, 'text');
							blockStopSent = false;
						}

						if (currentToolCallId) {
							sendContentBlockStop(controller);
							blockStopSent = true;
							currentToolCallId = null;
							currentToolName = null;
							currentToolArgs = '';

							contentBlockIndex++;
							sendContentBlockStart(controller, 'text');
							blockStopSent = false;
						}

						sendTextDelta(controller, delta.content);
					}

					if (choice.finish_reason) {
						if (thinkingBlockActive) {
							sendContentBlockStop(controller);
							blockStopSent = true;
							thinkingBlockActive = false;
						}
						if (currentToolCallId && currentToolArgs) {
							sendToolUseFinalInput(controller);
						}
					}
				} catch (e) { console.error('Anthropic processLines error:', e?.message || e); }
			}
		}
		return remaining;
	}

	function sendMessageStart(controller) {
		const event = {
			type: 'message_start',
			message: {
				id: messageId,
				type: 'message',
				role: 'assistant',
				content: [],
				model: modelName,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: inputTokens, output_tokens: outputTokens }
			}
		};
		controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendContentBlockStart(controller, blockType) {
		const event = {
			type: 'content_block_start',
			index: contentBlockIndex,
			content_block: blockType === 'tool_use'
				? { type: 'tool_use', id: currentToolCallId, name: currentToolName, input: {} }
				: blockType === 'thinking'
					? { type: 'thinking', thinking: '' }
					: { type: 'text', text: '' }
		};
		controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendTextDelta(controller, text) {
		const event = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: { type: 'text_delta', text }
		};
		controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendThinkingDelta(controller, thinking) {
		const event = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: { type: 'thinking_delta', thinking }
		};
		controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendToolUseDelta(controller, argsDelta) {
		const event = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: { type: 'input_json_delta', partial_json: argsDelta }
		};
		controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendToolUseFinalInput(controller) {
		controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
			type: 'content_block_stop',
			index: contentBlockIndex
		})}\n\n`));
		blockStopSent = true;
	}

	function sendContentBlockStop(controller) {
		controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
			type: 'content_block_stop',
			index: contentBlockIndex
		})}\n\n`));
	}

	function sendFinalEvent(controller) {
		if (finalEventSent) return;
		if (!streamStarted) {
			sendMessageStart(controller);
			contentBlockIndex++;
			sendContentBlockStart(controller, 'text');
		}
		if (!blockStopSent) {
			try { sendContentBlockStop(controller); } catch (_) { /* 忽略 enqueue 异常 */ }
		}
		blockStopSent = true;

		let stopReason = 'end_turn';
		if (currentToolCallId) {
			stopReason = 'tool_use';
		}

		const event = {
			type: 'message_delta',
			delta: {
				stop_reason: stopReason,
				stop_sequence: null
			},
			usage: { output_tokens: outputTokens || 0 }
		};
		try { controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(event)}\n\n`)); } catch (_) { /* 忽略 */ }

		try { controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({
			type: 'message_stop'
		})}\n\n`)); } catch (_) { /* 忽略 */ }
		finalEventSent = true;

		if (env && ctx && (inputTokens > 0 || outputTokens > 0)) {
			accumulateTokens(env, ctx, {
				input: inputTokens,
				output: outputTokens,
				reasoning: reasoningTokens,
				cacheRead: cacheReadTokens,
				cacheWrite: cacheWriteTokens,
				durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0,
			});
		}
	}
}

// ===== handleEmbeddings - 使用 AI Binding =====
async function handleEmbeddings(request, env, ctx) {
	const body = await safeJsonBody(request);
	if (!body) return jsonError("Request body too large (max 10MB)", 413, "invalid_request_error");

	const requestStartTime = Date.now();

	const { model, input } = body;
	if (!input) {
		return jsonError("input is required", 400, "invalid_request_error");
	}

	const { cfModel, isFallback } = await resolveModelName(model, env);
	const fallbackWarning = isFallback ? `Model "${model}" not found in mapping, fell back to ${cfModel}` : null;
	const textArray = Array.isArray(input) ? input : [input];

	try {
		const result = await env.AI.run(cfModel, { text: textArray });
		// AI Binding 返回格式: { data: [[...embeddings]] } 或直接是 embedding 数组
		let data;
		if (result.data && Array.isArray(result.data)) {
			data = result.data;
		} else if (Array.isArray(result)) {
			data = result;
		} else {
			data = [result];
		}

		const embeddings = data.map((emb, index) => ({
			object: "embedding", index, embedding: emb
		}));

		const response = {
			object: "list", data: embeddings, model,
			usage: {
				prompt_tokens: textArray.reduce((acc, text) => acc + Math.ceil(text.length / 3), 0),
				total_tokens: textArray.reduce((acc, text) => acc + Math.ceil(text.length / 3), 0)
			}
		};

		if (ctx) {
			accumulateTokens(env, ctx, { input: response.usage.prompt_tokens, durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0 });
		}

		const embHeaders = { 'Content-Type': 'application/json' };
		if (fallbackWarning) embHeaders['X-Model-Fallback-Warning'] = fallbackWarning;
		return new Response(JSON.stringify(response), { headers: embHeaders });
	} catch (e) {
		return jsonError(`Embeddings error: ${e.message}`, 502, "server_error");
	}
}

// ===== handleImageGenerations - 使用 AI Binding =====
async function handleImageGenerations(request, env, ctx) {
	const requestStartTime = Date.now();
	const body = await safeJsonBody(request);
	if (!body) return jsonError("Request body too large (max 10MB)", 413, "invalid_request_error");

	const { model, prompt, response_format } = body;
	if (!prompt) {
		return jsonError("prompt is required", 400, "invalid_request_error");
	}

	const { cfModel, isFallback } = await resolveModelName(model || 'flux-1-schnell', env);
	const fallbackWarning = isFallback ? `Model "${model || 'flux-1-schnell'}" not found in mapping, fell back to ${cfModel}` : null;

	let width = 1024, height = 1024;
	if (body.size && typeof body.size === 'string') {
		const parts = body.size.split('x');
		if (parts.length === 2) {
			width = parseInt(parts[0]) || 1024;
			height = parseInt(parts[1]) || 1024;
		}
	}

	try {
		const cfPayload = { prompt, width, height };
		if (cfModel.includes('flux')) cfPayload.num_steps = 4;

		const result = await env.AI.run(cfModel, cfPayload);

		// AI Binding 返回格式: { image: "base64string" } 或直接是 base64 字符串
		let rawImage = result.image || result;
		let base64Str;
		if (typeof rawImage === 'string') {
			base64Str = rawImage;
		} else {
			const bytes = new Uint8Array(rawImage);
			let binary = '';
			const chunkSize = 8192;
			for (let i = 0; i < bytes.length; i += chunkSize) {
				binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
			}
			base64Str = btoa(binary);
		}

		const responseData = {
			created: Math.floor(Date.now() / 1000),
			data: [{
				[response_format === 'b64_json' ? 'b64_json' : 'url']:
					response_format === 'b64_json' ? base64Str : `data:image/png;base64,${base64Str}`
			}],
		};

		const imgHeaders = { 'Content-Type': 'application/json' };
		if (fallbackWarning) imgHeaders['X-Model-Fallback-Warning'] = fallbackWarning;
		if (ctx && prompt) {
			accumulateTokens(env, ctx, { input: Math.ceil(prompt.length / 3), durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0 });
		}
		return new Response(JSON.stringify(responseData), { headers: imgHeaders });
	} catch (e) {
		return jsonError(`Image generation error: ${e.message}`, 502, "server_error");
	}
}

// ===== handleAudioTranscribe - 使用 AI Binding =====
async function handleAudioTranscribe(request, env, ctx, isTranslation) {
	const requestStartTime = Date.now();
	const contentType = request.headers.get('Content-Type') || '';
	if (!contentType.includes('multipart/form-data')) {
		return jsonError("Content-Type must be multipart/form-data", 400, "invalid_request_error");
	}

	const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
	if (contentLength > 100 * 1024 * 1024) {
		return jsonError("File size exceeds 100MB limit", 413, "invalid_request_error");
	}

	try {
		const formData = await request.formData();
		const audioFile = formData.get('file');
		const model = formData.get('model') || 'whisper';

		if (!audioFile) {
			return jsonError("file is required", 400, "invalid_request_error");
		}

		const { cfModel, isFallback } = await resolveModelName(model, env);
		const fallbackWarning = isFallback ? `Model "${model}" not found in mapping, fell back to ${cfModel}` : null;

		const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
		const actualCfModel = cfModel.includes('whisper') ? cfModel : WHISPER_MODEL;
		const actualFallbackWarning = cfModel.includes('whisper') ? fallbackWarning : `Model "${model}" is not a whisper model, forced to ${WHISPER_MODEL}`;

		// 读取音频文件为 ArrayBuffer
		const audioArrayBuffer = await audioFile.arrayBuffer();
		const audioUint8 = new Uint8Array(audioArrayBuffer);

		// AI Binding 的 Whisper 接受 { audio: ArrayBuffer } 格式
		const result = await env.AI.run(actualCfModel, {
			audio: [...audioUint8],
		});

		const text = result.text || '';

		if (ctx && text) {
			accumulateTokens(env, ctx, { output: Math.ceil(text.length / 3), durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0 });
		}

		const audioHeaders = { 'Content-Type': 'application/json' };
		if (actualFallbackWarning) audioHeaders['X-Model-Fallback-Warning'] = actualFallbackWarning;
		return new Response(JSON.stringify({ text }), { headers: audioHeaders });
	} catch (e) {
		return jsonError(`Failed to process audio${isTranslation ? ' translation' : ''}: ${e?.message || e}`, 400, "invalid_request_error");
	}
}

// ===== handleAudioSpeech - 使用 AI Binding =====
async function handleAudioSpeech(request, env, ctx) {
	const body = await safeJsonBody(request);
	if (!body) return jsonError("Request body too large (max 10MB)", 413, "invalid_request_error");

	const requestStartTime = Date.now();
	const { model, input, voice } = body;
	if (!input) {
		return jsonError("input is required", 400, "invalid_request_error");
	}

	const { cfModel, isFallback } = await resolveModelName(model || 'tts', env);
	const fallbackWarning = isFallback ? `Model "${model || 'tts'}" not found in mapping, fell back to ${cfModel}` : null;

	const cfPayload = { prompt: input };
	if (voice) cfPayload.voice = voice;
	if (body.response_format) cfPayload.response_format = body.response_format;
	if (body.speed !== undefined) cfPayload.speed = body.speed;

	try {
		const resp = await env.AI.run(cfModel, cfPayload, { returnRawResponse: true });
		if (!resp.ok) {
			const errText = await resp.text();
			return jsonError(`TTS error (${resp.status}): ${errText}`, resp.status, "server_error");
		}
		const audioBuffer = await resp.arrayBuffer();
		const contentType = resp.headers.get('Content-Type') || 'audio/wav';
		if (ctx) {
			accumulateTokens(env, ctx, { input: Math.ceil(input.length / 4), durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0 });
		}
		return new Response(audioBuffer, {
			headers: {
				'Content-Type': contentType,
				...(fallbackWarning ? { 'X-Model-Fallback-Warning': fallbackWarning } : {}),
			}
		});
	} catch (e) {
		return jsonError(`TTS error: ${e.message}`, 502, "server_error");
	}
}

// ===== handleCountTokens =====
async function handleCountTokens(request, env) {
	const body = await safeJsonBody(request);
	if (!body) return anthropicError("Request body too large or invalid");

	if (!body.messages || !Array.isArray(body.messages)) {
		return anthropicError('messages field is required and must be an array.');
	}

	let totalChars = 0;

	if (body.system) {
		if (typeof body.system === 'string') {
			totalChars += body.system.length;
		} else if (Array.isArray(body.system)) {
			for (const block of body.system) {
				if (block.type === 'text' && block.text) totalChars += block.text.length;
			}
		}
	}

	for (const msg of body.messages) {
		if (typeof msg.content === 'string') {
			totalChars += msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text' && block.text) {
					totalChars += block.text.length;
				} else if (block.type === 'thinking' && block.thinking) {
					totalChars += block.thinking.length;
				} else if (block.type === 'image') {
					const source = block.source || {};
					if (source.data) {
						totalChars += Math.ceil(source.data.length / 4);
					}
				} else if (block.type === 'tool_use') {
					totalChars += JSON.stringify(block.input || {}).length;
				} else if (block.type === 'tool_result') {
					if (typeof block.content === 'string') {
						totalChars += block.content.length;
					} else if (Array.isArray(block.content)) {
						for (const c of block.content) {
							if (c.type === 'text' && c.text) totalChars += c.text.length;
						}
					}
				}
			}
		}
	}

	if (body.tools && Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			totalChars += (tool.name || '').length;
			totalChars += (tool.description || '').length;
			totalChars += JSON.stringify(tool.input_schema || {}).length;
		}
	}

	const estimatedTokens = Math.ceil(totalChars / 3);

	return new Response(JSON.stringify({
		input_tokens: estimatedTokens,
	}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ===== passthroughStream - 透传 SSE 流 =====
function passthroughStream(upstreamBody, modelName, isCompletion, env, ctx, requestStartTime) {
	const reader = upstreamBody.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let streamUsage = null;
	let pingInterval = null;

	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`));
			pingInterval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`));
				} catch (_) { /* controller 已关闭 */ }
			}, 10000);
		},
		async pull(controller) {
			let timeoutRetries = 0;
			try {
				while (true) {
					let result;
					try {
						result = await readWithTimeout(reader, 120000);
					} catch (e) {
						if (e.message === 'Stream read timed out' && timeoutRetries < MAX_TIMEOUT_RETRIES) {
							timeoutRetries++;
							await new Promise(r => setTimeout(r, Math.min(1000 * timeoutRetries, 5000)));
							continue;
						}
						throw e;
					}
					timeoutRetries = 0;
					if (result.done) {
						if (buffer.trim()) {
							buffer = processLines(buffer, controller);
							if (buffer.trim()) {
								controller.enqueue(encoder.encode(`data: ${buffer.trim()}\n\n`));
							}
						}
						controller.enqueue(encoder.encode('data: [DONE]\n\n'));
						controller.close();
						if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
						accumulateFromUsage(env, ctx, streamUsage, requestStartTime);
						break;
					}

					buffer += decoder.decode(result.value, { stream: true });
					buffer = processLines(buffer, controller);

					if (buffer.indexOf('\n') === -1) {
						break;
					}
				}
			} catch (e) {
				console.error(`passthroughStream upstream error: ${e?.message || e}`);
				try {
					if (buffer.trim()) {
						buffer = processLines(buffer, controller);
					}
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				} catch (e2) { console.error('passthroughStream secondary error:', e2?.message || e2); }
				try { controller.close(); } catch (_) { }
			}
		},
		cancel() {
			if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
			return reader.cancel();
		},
	});

	function processLines(data, controller) {
		const lines = data.split('\n');
		const remaining = lines.pop();

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (trimmed.startsWith('data: ')) {
				const dataStr = trimmed.slice(6);
				if (dataStr === '[DONE]') continue;

				try {
					const chunk = JSON.parse(dataStr);
					if (chunk.model !== undefined) chunk.model = modelName;
					if (chunk.usage) streamUsage = chunk.usage;
					if (isCompletion) {
						chunk.object = 'text_completion';
						if (chunk.choices) {
							for (const c of chunk.choices) {
								if (c.delta?.content !== undefined) {
									c.text = c.delta.content;
									delete c.delta;
								}
								if (c.message?.content !== undefined) {
									c.text = c.message.content;
									delete c.message;
								}
							}
						}
					}
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				} catch (_) {
					controller.enqueue(encoder.encode(`${line}\n`));
				}
			} else {
				controller.enqueue(encoder.encode(`${line}\n`));
			}
		}
		return remaining;
	}
}

async function safeJsonBody(request, sizeLimitMB = 128) {
	const ct = request.headers.get('Content-Type') || '';
	if (!ct.includes('application/json') && !ct.includes('text/plain')) return null;
	const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
	if (contentLength > sizeLimitMB * 1024 * 1024) return null;
	try { return await request.json(); } catch { return null; }
}

function streamResponse(stream, fallbackWarning) {
	const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };
	if (fallbackWarning) headers['X-Model-Fallback-Warning'] = fallbackWarning;
	return new Response(stream, { headers });
}

function jsonResponse(data, fallbackWarning) {
	const headers = { 'Content-Type': 'application/json' };
	if (fallbackWarning) headers['X-Model-Fallback-Warning'] = fallbackWarning;
	return new Response(JSON.stringify(data), { headers });
}

// ===== handleDashboardApi - 简化版（无多账号） =====
async function handleDashboardApi(request, env, ctx) {
	const url = new URL(request.url);
	const method = request.method;

	// 登录
	if (url.pathname === '/api/auth/login' && method === 'POST') {
		const { password } = await safeJsonBody(request) || {};
		if (!env.ADMIN_PASSWORD || !env.ADMIN_PASSWORD.trim()) {
			return new Response(JSON.stringify({ error: 'ADMIN_PASSWORD not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
		}
		const expectedPassword = env.ADMIN_PASSWORD.trim();
		if (password === expectedPassword) {
			const token = await sha256(password);
			return new Response(JSON.stringify({ success: true }), {
				headers: {
					'Content-Type': 'application/json',
					'Set-Cookie': `admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
				}
			});
		} else {
			return new Response(JSON.stringify({ error: 'Incorrect password' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
		}
	}

	if (url.pathname === '/api/auth/logout' && method === 'POST') {
		return new Response(JSON.stringify({ success: true }), {
			headers: {
				'Content-Type': 'application/json',
				'Set-Cookie': `admin_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
			}
		});
	}

	// 用量汇总（简化版：从 token 统计 KV 获取）
	if (url.pathname === '/api/usage/summary') {
		const isAuthorized = await checkAdminAuth(request, env);
		if (!isAuthorized) {
			return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'X-Request-Id': generateRequestId() } });
		}

		if (method === 'GET' || method === 'POST') {
			const limits = await getUsageLimits(env);
			const stats = await getTodayTokenStats(env);
			const monthlyUsage = await getMonthlyUsage(env);

			const summary = {
				totalNeuronsToday: stats.total,
				totalRequestsToday: stats.requests,
				totalRequestsMonth: 0,
				totalAccounts: 1,
				totalLimit: limits.dailyLimit,
				usagePercentage: limits.dailyLimit > 0 ? parseFloat(((stats.total / limits.dailyLimit) * 100).toFixed(2)) : 0,
				modelsToday: [],
				dailyUsage: stats.total,
				dailyLimit: limits.dailyLimit,
				monthlyUsage: monthlyUsage,
				monthlyLimit: limits.monthlyLimit,
				threshold: limits.threshold,
				dailyRequests: stats.requests,
				monthlyRequests: 0
			};
			return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json', 'X-Request-Id': generateRequestId() } });
		}
	}

	const isAuthorized = await checkAdminAuth(request, env);
	if (!isAuthorized) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
	}

	// CSRF 防护
	if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
		const cookies = request.headers.get('Cookie') || '';
		const csrfCookieMatch = cookies.match(/csrf_token=([^;]+)/);
		const csrfCookie = csrfCookieMatch ? csrfCookieMatch[1] : null;
		const csrfHeader = request.headers.get('X-CSRF-Token');
		if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
			return new Response(JSON.stringify({ error: 'CSRF token validation failed. Please refresh the page.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 获取账号信息（简化版：返回单账号信息）
	if (url.pathname === '/api/accounts' && method === 'GET') {
		return new Response(JSON.stringify([{
			id: 'binding-single',
			name: 'AI Binding (Single Account)',
			accountId: 'binding',
			apiToken: '********',
			status: 'active'
		}]), { headers: { 'Content-Type': 'application/json' } });
	}

	// 账号用量（简化版：返回空数据）
	if (url.pathname === '/api/accounts/usage' && method === 'GET') {
		const limits = await getUsageLimits(env);
		const stats = await getTodayTokenStats(env);
		const monthlyUsage = await getMonthlyUsage(env);

		return new Response(JSON.stringify({
			accounts: [{
				id: 'binding-single',
				name: 'AI Binding',
				accountId: 'binding',
				status: 'active',
				error: undefined,
				usageToday: stats.total,
				usageTodayRequests: stats.requests,
				modelsToday: [],
				history: [],
				lastUpdated: Date.now()
			}],
			limits: {
				dailyUsage: stats.total,
				dailyRequests: stats.requests,
				dailyLimit: limits.dailyLimit,
				monthlyUsage: monthlyUsage,
				monthlyRequests: 0,
				monthlyLimit: limits.monthlyLimit,
				threshold: limits.threshold
			}
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	if (url.pathname === '/api/keys') {
		if (method === 'GET') {
			const keys = await getApiKeys(env);
			return new Response(JSON.stringify(keys), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'POST') {
			const { name, key } = await safeJsonBody(request) || {};
			if (!name) {
				return new Response(JSON.stringify({ error: 'Name is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			}

			const generatedKey = key || `sk-wa-${crypto.randomUUID().replace(/-/g, '')}`;
			const keys = await getApiKeys(env);
			keys.push({
				id: crypto.randomUUID(),
				name,
				key: generatedKey,
				createdAt: new Date().toISOString()
			});
			await saveApiKeys(env, keys);
			return new Response(JSON.stringify({ success: true, key: generatedKey }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	if (url.pathname.startsWith('/api/keys/') && method === 'DELETE') {
		const id = decodeURIComponent(url.pathname.slice('/api/keys/'.length));
		const keys = await getApiKeys(env);
		const filtered = keys.filter(k => k.id !== id);
		await saveApiKeys(env, filtered);
		return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
	}

	if (url.pathname === '/api/settings') {
		if (method === 'GET') {
			const customMap = await getCustomModelMap(env);
			return new Response(JSON.stringify({ customModelMap: customMap }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'PUT') {
			const { customModelMap } = await safeJsonBody(request) || {};
			if (!customModelMap || typeof customModelMap !== 'object') {
				return new Response(JSON.stringify({ error: 'Invalid customModelMap payload' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			await saveCustomModelMap(env, customModelMap);
			return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	if (url.pathname === '/api/limits') {
		if (method === 'GET') {
			const limits = await getUsageLimits(env);
			return new Response(JSON.stringify(limits), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'PUT') {
			const body = await safeJsonBody(request);
			const { dailyLimit, monthlyLimit, threshold } = body || {};
			const updates = {};
			if (dailyLimit !== undefined) {
				const val = parseInt(dailyLimit, 10);
				if (isNaN(val) || val < 0) {
					return new Response(JSON.stringify({ error: 'dailyLimit must be a non-negative integer' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				updates.dailyLimit = val;
			}
			if (monthlyLimit !== undefined) {
				const val = parseInt(monthlyLimit, 10);
				if (isNaN(val) || val < 0) {
					return new Response(JSON.stringify({ error: 'monthlyLimit must be a non-negative integer' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				updates.monthlyLimit = val;
			}
			if (threshold !== undefined) {
				const val = parseFloat(threshold);
				if (isNaN(val) || val < 0 || val > 1) {
					return new Response(JSON.stringify({ error: 'threshold must be a number between 0 and 1' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				updates.threshold = val;
			}
			if (Object.keys(updates).length === 0) {
				return new Response(JSON.stringify({ error: 'No valid fields provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			}

			await saveUsageLimitsConfig(env, updates);

			const newLimits = await getUsageLimits(env);
			return new Response(JSON.stringify({ success: true, limits: newLimits }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 今日 Token 统计
	if (url.pathname === '/api/tokens/today' && method === 'GET') {
		const stats = await getTodayTokenStats(env);
		const _ft = n => n < 1000 ? String(n) : n < 1000000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : n < 1000000000 ? (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M' : (n / 1000000000).toFixed(2).replace(/\.?0+$/, '') + 'B';
		return new Response(JSON.stringify({
			input: stats.input,
			output: stats.output,
			reasoning: stats.reasoning,
			cacheRead: stats.cacheRead,
			cacheWrite: stats.cacheWrite,
			total: stats.total,
			requests: stats.requests,
			avgTokPerSec: stats.avgTokPerSec,
			inputFmt: _ft(stats.input),
			outputFmt: _ft(stats.output),
			reasoningFmt: _ft(stats.reasoning),
			totalFmt: _ft(stats.total),
			cacheReadFmt: _ft(stats.cacheRead),
			cacheWriteFmt: _ft(stats.cacheWrite),
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}