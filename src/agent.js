// 大模型调用循环：调 LLM → 执行工具 → 直到没有工具调用。两条协议（openai 兼容、anthropic）都 fetch 直连。
import { toolDefs, runTool } from "./tools.js";
import { retry, fatal, stripSlash, safeSlice, ERR_CLIP } from "./util.js";
import { estimateTokens, enforceBudget, stripThinkTags, dropAvatarNote } from "./prompt.js";
import { VISION_MEDIA_TYPES } from "./fetch-image.js";


const LLM_RETRY_BASE_MS = 500;   // 重试退避基数（× 第几次）
const LLM_RATE_LIMIT_MS = 4000;  // 429（上游限流 / 负载饱和）退避基数（× 第几次）：隔半秒再撞一次多半还是 429，白耗重试次数
const LLM_RETRY_AFTER_MAX_MS = 20_000;  // 服务端给了 Retry-After 也最多等这么久（一轮的总时限由 turnTimeoutMs 兜）
const ARGS_ECHO_CHARS = 80;      // 工具参数解析失败时，把收到的原文回显给模型这么长

// 服务端认哪个 token 限制字段：按 baseUrl+model 记住，热更新重建 agent 也不忘（省掉重复的 400 试错往返）
const tokensFieldByModel = new Map();

/** 按协议选 runner。 */
export function makeAgent(cfg, log) {
  const a = { ...cfg.agent, vision: cfg.images.vision };
  return { run: a.protocol === "anthropic" ? anthropicRunner(a, log) : openaiRunner(a, log) };
}

// ---- 一轮的总时限 ----

/** 总时限到了：不再重试、不再调工具。带 fatal，retry 见到就不再试。 */
const deadlineError = () => Object.assign(new Error("本轮总时限已到"), { fatal: true, deadline: true });

/** 距 deadline 还剩多少毫秒；没剩了直接抛。 */
function remaining(deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) throw deadlineError();
  return ms;
}

/** 让 p 最多等到 deadline：工具卡住（平台接口慢）也拖不过总时限。超时后 p 自己跑完，结果丢弃。 */
function beforeDeadline(p, deadline) {
  let timer;
  const stop = new Promise((_, reject) => { timer = setTimeout(() => reject(deadlineError()), Math.max(0, deadline - Date.now())); });
  return Promise.race([p, stop]).finally(() => clearTimeout(timer));
}

/** 这一轮的截止时刻（agent.turnTimeoutMs，校验保证不短于单次请求超时）：模型端挂住时别把会话堵上十几分钟。deadlineMs 只给测试用。 */
const runDeadline = (a, deadlineMs) => Date.now() + (deadlineMs ?? a.turnTimeoutMs);

/**
 * POST JSON 带重试：网络错误 / 5xx / 429 / 2xx 但响应不合格重试，其余 4xx 直接抛。
 * 单次超时按 min(timeoutMs, 距 deadline 剩的) 算；到了 deadline 抛 deadline 错误，不再重试。
 */
function postJson(url, headers, body, { timeoutMs, retries, accept, log, deadline = Infinity }) {
  return retry(async () => {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(timeoutMs, remaining(deadline))) });
    const json = await res.json().catch(() => null);
    if (res.ok && accept(json)) return json;
    const msg = `LLM HTTP ${res.status}: ${json?.error?.message || safeSlice(String(JSON.stringify(json)), ERR_CLIP)}`;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw fatal(msg);
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    throw Object.assign(new Error(msg), res.status === 429 ? { rateLimited: true, retryAfterMs: retryAfter > 0 ? Math.min(retryAfter, LLM_RETRY_AFTER_MAX_MS) : 0 } : {});
  }, {
    retries,
    // 限流按 Retry-After（有的话）或更长的退避等；等不到 deadline 前就别等了，交给上层按失败处理
    delay: (n, e) => Math.min(e?.rateLimited ? e.retryAfterMs || LLM_RATE_LIMIT_MS * n : LLM_RETRY_BASE_MS * n, Math.max(0, remaining(deadline))),
    onRetry: (e, n) => log?.warn(`模型请求失败，第 ${n} 次重试：${safeSlice(e.message, ERR_CLIP)}`),
  });
}

// ---- 工具调用 ----

/**
 * 模型给的工具参数 → { input } 或 { error }。openai 的 arguments 是模型写的 JSON 字符串，会截断、会写坏：
 * 解析不了、或不是对象，就别拿 {} 硬跑工具（remember 会记下 "undefined"），把错误交回模型让它重来。
 */
function parseToolArgs(raw) {
  if (raw == null || (typeof raw === "string" && !raw.trim())) return { input: {} };
  let v = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch (e) { return { error: `参数不是合法 JSON：${e.message}（收到的是：${safeSlice(raw, ARGS_ECHO_CHARS)}）` }; }
  }
  if (v === null) return { input: {} };
  return typeof v === "object" && !Array.isArray(v) ? { input: v } : { error: "参数必须是一个 JSON 对象" };
}

/** 参数不合格的调用：不执行，给模型一个出错的结果，照常记日志。 */
function rejectArgs(name, error, log) {
  log.event("tool", { tool: name, ok: false, ms: 0, error });
  return { out: `错误：${error}。按工具说明的参数格式重新调用一次`, ok: false };
}

/**
 * 执行一个工具调用，错误转成文本返回给模型，不中断循环。耗时与返回长度都记进日志，好分辨「平台慢」还是「模型慢」。
 * 结果先补齐坏掉的代理对（平台报错摘要这类别处截断的文字可能带着半个 emoji），截断也不切开 emoji：孤立代理进了请求 JSON，Anthropic 会整条 400。
 */
async function execTool(tools, name, input, log, maxChars) {
  const t0 = Date.now();
  try {
    const raw = String(await runTool(tools, name, input)).toWellFormed();
    const out = raw.length > maxChars ? safeSlice(raw, maxChars) + `\n…（工具结果超过 ${maxChars} 字已截断）` : raw;
    log.event("tool", { tool: name, input, ok: true, ms: Date.now() - t0, outLen: raw.length, truncated: raw.length > maxChars });
    return { out, ok: true };
  } catch (e) {
    log.event("tool", { tool: name, input, ok: false, ms: Date.now() - t0, error: e.message });
    return { out: `错误：${String(e.message).toWellFormed()}`, ok: false };
  }
}

/** 解析参数、执行（最多等到 deadline），返回 { out, ok }；到了 deadline 抛 deadline 错误。 */
async function callTool(tools, name, rawArgs, L, a, deadline) {
  const parsed = parseToolArgs(rawArgs);
  if (parsed.error) return rejectArgs(name, parsed.error, L);
  return beforeDeadline(execTool(tools, name, parsed.input, L, a.toolResultMaxChars), deadline);
}

/**
 * 同一个工具这一轮报了同样的错：模型换个参数重试也只会再错一次，每次都白等一轮模型。
 * 第二次起在错误后面明说别再调，让它直接用文字回。failures 是这一轮的「工具名|错误」计数，由 run 持有。
 */
const REPEAT_NOTE = "\n（这个错误这一轮已经出现过了，换参数重试也一样，别再调这个工具，直接用文字回复）";
function noteRepeat(failures, name, res) {
  if (res.ok) return res;
  const key = `${name}|${res.out}`;
  const n = (failures.get(key) || 0) + 1;
  failures.set(key, n);
  return n > 1 ? { ...res, out: res.out + REPEAT_NOTE } : res;
}

// ---- 图片 ----

const isImageRejected = (err) => /image|vision|multimodal|不支持图/i.test(err.message);
const IMAGE_FAILED_NOTE = "\n\n（本轮的图片没能送进模型，你看不到图；被问图就直说看不了，别猜内容）";  // 纯文字重试时追加，免得模型照着「能看图」的规则编

/** 图没送进模型时的 user 文本：去掉头像附图说明（「最后一张是头像」已经不成立），再说明这轮看不到图。 */
const textOnly = (userText) => dropAvatarNote(userText) + IMAGE_FAILED_NOTE;

/**
 * 送进模型之前先过一遍图片类型：不在 VISION_MEDIA_TYPES 里的（bmp 等）两家都会整条 400。
 * 有一张不合格就整轮按纯文字走——只丢那一张的话，「最后一张图是头像」就对不上号了。harness 会先过滤，这里兜底。
 */
function prepareImages(images, userText, L) {
  const bad = images.filter((img) => img.base64 && !VISION_MEDIA_TYPES.has(img.mediaType));
  if (!bad.length) return { imgs: images, text: userText, dropped: false };
  L.warn(`模型不认的图片类型（${bad.map((b) => b.mediaType).join("、")}），本轮改为纯文字`);
  return { imgs: [], text: textOnly(userText), dropped: true };
}

// ---- OpenAI 兼容 ----

/** baseUrl 已含 /vN 只补 /chat/completions，否则补 /v1/chat/completions。 */
export function chatCompletionsUrl(baseUrl) {
  const base = stripSlash(baseUrl);
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export const toOpenAITools = (tools) => toolDefs(tools).map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// 图片项：{ mediaType, base64 } 首选，{ url } 是下载失败的回退
function openaiUserContent(text, images) {
  if (!images.length) return text;
  const part = (img) => ({ type: "image_url", image_url: { url: img.base64 ? `data:${img.mediaType};base64,${img.base64}` : img.url } });
  return [...images.map(part), { type: "text", text }];
}

const isTokensFieldRejected = (err) => /max_completion_tokens/i.test(err.message);

function openaiRunner(a, log) {
  const url = chatCompletionsUrl(a.baseUrl);
  const headers = { "content-type": "application/json", authorization: `Bearer ${a.token}` };
  const timeoutMs = a.timeoutMs;
  // OpenAI 官方新模型只认 max_completion_tokens，DeepSeek / 各类中转多数只认 max_tokens：先按后者发，被拒就切换并按模型记住
  const tokensKey = `${a.baseUrl}|${a.model}`;
  let tokensField = tokensFieldByModel.get(tokensKey) || "max_tokens";

  return async function run({ system, userText, images = [], tools, log: runLog, deadlineMs }) {
    const L = runLog || log;  // 每轮从 harness 传进来的子日志器（带 conv / turn），没有就用构造时那个
    const deadline = runDeadline(a, deadlineMs);
    const failures = new Map();  // 这一轮各工具报过的错，见 noteRepeat
    userText = String(userText).toWellFormed();  // 旧数据里可能已经存着半个 emoji（截坏的表情名、备忘），进请求前补齐
    const vis = prepareImages(a.vision ? images : [], userText, L);
    let imgs = vis.imgs;
    let visionDropped = vis.dropped;
    const messages = [{ role: "system", content: String(system).toWellFormed() }, { role: "user", content: openaiUserContent(vis.text, imgs) }];
    const usage = { input: 0, output: 0 };
    const oaTools = toOpenAITools(tools);
    const baseTokens = estimateTokens(JSON.stringify(oaTools));  // system 在 messages 里，由 enforceBudget 逐条算
    let toolCalls = 0;
    const timedOut = (turns) => ({ text: null, reason: "timeout", usage, turns, toolCalls, visionDropped });

    for (let turn = 0; turn < a.maxTurns; turn++) {
      if (Date.now() >= deadline) return timedOut(turn);
      enforceBudget(messages, baseTokens, a.maxInputTokens);
      let json;
      try {
        json = await postJson(url, headers, {
          model: a.model,
          [tokensField]: a.maxOutputTokens,
          ...(a.effort ? { reasoning_effort: a.effort } : {}),
          messages,
          ...(oaTools.length ? { tools: oaTools, tool_choice: "auto" } : {}),
        }, { timeoutMs, retries: a.retries, accept: (j) => j?.choices?.length, log: L, deadline });
      } catch (err) {
        if (err.deadline || Date.now() >= deadline) return timedOut(turn);  // 最后一次请求被截到 deadline 而超时，也按总时限到了算
        if (tokensField === "max_tokens" && isTokensFieldRejected(err)) {  // 换字段名重发，不算一轮
          L.warn(`服务端要求 max_completion_tokens，已切换：${safeSlice(err.message, ERR_CLIP)}`);
          tokensField = "max_completion_tokens";
          tokensFieldByModel.set(tokensKey, tokensField);
          turn--;
          continue;
        }
        if (imgs.length && isImageRejected(err)) {  // 图片被拒就纯文字重试一次，也不算一轮；openai 没有「历史只追加」的约束，直接改写首条 user
          L.warn(`图片输入被拒绝，改为纯文字：${safeSlice(err.message, ERR_CLIP)}`);
          imgs = [];
          visionDropped = true;
          messages[1] = { role: "user", content: textOnly(userText) };
          turn--;
          continue;
        }
        throw err;
      }
      addUsage(usage, json.usage?.prompt_tokens, json.usage?.completion_tokens);
      const choice = json.choices[0];
      const m = choice?.message || {};
      const calls = m.tool_calls || [];
      const content = Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : m.content || "";
      if (!calls.length) {
        const { text, stripped } = stripThinkTags(content);
        if (stripped) L.warn("模型把思考标记漏进了正文，已清掉");
        return { text, reason: choice?.finish_reason, usage, turns: turn + 1, toolCalls, visionDropped };
      }

      // 只回传协议字段：推理模型附带的 reasoning_content 回传会被部分服务端拒绝
      messages.push({ role: "assistant", content: m.content ?? null, tool_calls: calls });
      try {
        for (const tc of calls) {
          const { out } = noteRepeat(failures, tc.function?.name, await callTool(tools, tc.function?.name, tc.function?.arguments, L, a, deadline));
          toolCalls++;
          messages.push({ role: "tool", tool_call_id: tc.id, content: out });
        }
      } catch (err) {
        if (err.deadline) return timedOut(turn + 1);
        throw err;
      }
    }
    return { text: null, reason: "max-turns", usage, turns: a.maxTurns, toolCalls, visionDropped };
  };
}

// ---- Anthropic Messages API ----

/** baseUrl 已含 /vN 只补 /messages，否则补 /v1/messages；留空用官方地址。 */
export function messagesUrl(baseUrl) {
  const base = stripSlash(baseUrl || "https://api.anthropic.com");
  return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

function anthropicUserContent(text, images) {
  const part = (img) => ({
    type: "image",
    source: img.base64 ? { type: "base64", media_type: img.mediaType, data: img.base64 } : { type: "url", url: img.url },
  });
  return [...images.map(part), { type: "text", text }];
}

function anthropicRunner(a, log) {
  const url = messagesUrl(a.baseUrl || process.env.ANTHROPIC_BASE_URL);
  // config.token / ANTHROPIC_API_KEY 走 x-api-key；仅显式用 ANTHROPIC_AUTH_TOKEN 时走 Bearer
  const key = a.token || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
  const auth = !a.token && process.env.ANTHROPIC_AUTH_TOKEN ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...auth };
  const timeoutMs = a.timeoutMs;

  return async function run({ system, userText, images = [], tools, log: runLog, deadlineMs }) {
    const L = runLog || log;
    const deadline = runDeadline(a, deadlineMs);
    const failures = new Map();  // 这一轮各工具报过的错，见 noteRepeat
    system = String(system).toWellFormed();
    userText = String(userText).toWellFormed();
    const vis = prepareImages(a.vision ? images : [], userText, L);
    let imgs = vis.imgs;
    let visionDropped = vis.dropped;
    const messages = [{ role: "user", content: anthropicUserContent(vis.text, imgs) }];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const defs = toolDefs(tools);
    const baseTokens = estimateTokens(system) + estimateTokens(JSON.stringify(defs));  // system 是独立参数，并入基线
    let toolCalls = 0;
    const timedOut = (turns) => ({ text: null, reason: "timeout", usage, turns, toolCalls, visionDropped });

    for (let turn = 0; turn < a.maxTurns; turn++) {
      if (Date.now() >= deadline) return timedOut(turn);
      enforceBudget(messages, baseTokens, a.maxInputTokens, { appendOnly: true });  // 已发过的历史不能改（preserved thinking）
      let res;
      try {
        res = await postJson(url, headers, {
          model: a.model,
          max_tokens: a.maxOutputTokens,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          ...(a.thinking ? { thinking: { type: a.thinking } } : {}),
          ...(a.effort ? { output_config: { effort: a.effort } } : {}),
          tools: defs,
          messages,
        }, { timeoutMs, retries: a.retries, accept: (j) => Array.isArray(j?.content), log: L, deadline });
      } catch (err) {
        if (err.deadline || Date.now() >= deadline) return timedOut(turn);  // 最后一次请求被截到 deadline 而超时，也按总时限到了算
        // 图片被拒就纯文字重试一次，不算一轮。只在还没有 assistant 轮次时改写首条（被拒的那次请求不算历史）；
        // 之后再改就动了已发过的历史，违反「只追加」，宁可这一轮失败
        if (imgs.length && messages.length === 1 && isImageRejected(err)) {
          L.warn(`图片输入被拒绝，改为纯文字：${safeSlice(err.message, ERR_CLIP)}`);
          imgs = [];
          visionDropped = true;
          messages[0] = { role: "user", content: textOnly(userText) };
          turn--;
          continue;
        }
        throw err;
      }
      addUsage(usage, res.usage?.input_tokens, res.usage?.output_tokens, res.usage);
      if (res.stop_reason === "refusal") {
        const d = res.stop_details || {};
        L.warn(`模型拒绝回答（${d.category || "未分类"}）${d.explanation ? `：${d.explanation}` : ""}`);
        return { text: null, reason: "refusal", category: d.category || null, usage, turns: turn + 1, toolCalls, visionDropped };
      }

      const { text, stripped } = stripThinkTags(res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
      if (stripped) L.warn("模型把思考标记漏进了正文，已清掉");
      const uses = res.content.filter((b) => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) return { text, reason: res.stop_reason, usage, turns: turn + 1, toolCalls, visionDropped };

      messages.push({ role: "assistant", content: res.content });  // 原样回传，含 thinking 块
      const results = [];
      try {
        for (const u of uses) {
          const { out, ok } = noteRepeat(failures, u.name, await callTool(tools, u.name, u.input, L, a, deadline));
          toolCalls++;
          results.push({ type: "tool_result", tool_use_id: u.id, content: out, ...(ok ? {} : { is_error: true }) });
        }
      } catch (err) {
        if (err.deadline) return timedOut(turn + 1);
        throw err;
      }
      messages.push({ role: "user", content: results });
    }
    return { text: null, reason: "max-turns", usage, turns: a.maxTurns, toolCalls, visionDropped };
  };
}

function addUsage(acc, input, output, anthropicUsage) {
  acc.input += input || 0;
  acc.output += output || 0;
  if (anthropicUsage) {
    acc.cacheRead += anthropicUsage.cache_read_input_tokens || 0;
    acc.cacheWrite += anthropicUsage.cache_creation_input_tokens || 0;
  }
}
