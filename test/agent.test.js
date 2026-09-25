import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAgent, chatCompletionsUrl, messagesUrl, toOpenAITools } from "../src/agent.js";
import { stripThinkTags } from "../src/prompt.js";
import { AVATAR_NOTE } from "../src/prompt.js";

const think = (s) => stripThinkTags(s).text;  // 只关心清完的正文

test("stripThinkTags：整块 <think> 与孤零零的结束标记（含随机后缀）都去掉，正文保留；stripped 标出这轮确实清过东西", () => {
  assert.equal(think("答案</think_never_used_51bce0c785ca2f68081bfa7d91973934>NO_REPLY"), "答案 NO_REPLY");  // 带后缀的特殊 token 前后都是正文，换成空格
  assert.equal(think("<think>先想想\n再想想</think>\n结论"), "结论");
  assert.equal(think("<think_x>abc</think_x>结论<think>没闭合"), "结论");  // 已经出现过成对的块，后面没闭合的也是思考
  assert.equal(think("正常回复，不含标记"), "正常回复，不含标记");
  assert.equal(think(null), "");
  assert.deepEqual(stripThinkTags("答案</think_never_used_abc>"), { text: "答案", stripped: true });   // 漏标记要留痕
  assert.deepEqual(stripThinkTags("正常回复"), { text: "正常回复", stripped: false });
  assert.deepEqual(stripThinkTags("  两边空白  "), { text: "两边空白", stripped: false });  // 只是 trim 不算清理
});

test("stripThinkTags：换成空格不粘连；R1 式只有 </think> 时删掉它之前的思考；没闭合的 <think> 只在开头才删到底，正文里提到不动", () => {
  assert.equal(think("改到周五 10:30</think_never_used_abc>NO_REPLY"), "改到周五 10:30 NO_REPLY");  // 不粘成 10:30NO_REPLY
  assert.equal(think("用户在问昨天的事，我先翻记录。</think>\n\n昨天聊的是周末聚餐"), "昨天聊的是周末聚餐");
  assert.equal(think("想一下</think>再想</thinking>答案"), "答案");  // 取最后一个结束标记
  assert.equal(think("只有思考没有答案</think>"), "");  // 宁可不发，也不把思考发进群
  assert.equal(think("<think>一直在想，被 max_tokens 截断了"), "");
  assert.equal(think("推理模型会输出 <think> 标签，后面跟着思考内容，然后才是答案"), "推理模型会输出 <think> 标签，后面跟着思考内容，然后才是答案");
  assert.deepEqual(stripThinkTags("推理模型会输出 <think> 标签"), { text: "推理模型会输出 <think> 标签", stripped: false });
});

test("OpenAI 端点拼接", () => {
  assert.equal(chatCompletionsUrl("https://api.example.com"), "https://api.example.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.x.com/v1"), "https://api.x.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.x.com/"), "https://api.x.com/v1/chat/completions");
});
test("Anthropic 端点拼接", () => {
  assert.equal(messagesUrl("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  assert.equal(messagesUrl("https://x.com/v1/"), "https://x.com/v1/messages");
  assert.equal(messagesUrl(""), "https://api.anthropic.com/v1/messages");
});
test("工具定义转 OpenAI function", () => {
  const tools = [{ name: "t", description: "d", input_schema: { type: "object", properties: {} }, run() {} }];
  assert.deepEqual(toOpenAITools(tools), [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }]);
});

// ---- runner：mock fetch 走完整工具循环 ----
const log = { warn() {}, event() {}, info() {}, error() {} };
const echoTool = { name: "echo", description: "回显", input_schema: { type: "object", properties: { s: { type: "string" } } }, async run({ s }) { return `echo:${s}`; } };
const failTool = { name: "boom", description: "总失败", input_schema: { type: "object", properties: {} }, async run() { throw new Error("炸了"); } };
const withFetch = async (impl, fn) => {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const baseCfg = (protocol) => ({ agent: { protocol, baseUrl: "https://llm", token: "k", model: "m", maxOutputTokens: 100, maxInputTokens: 0, maxTurns: 4, timeoutMs: 5000, turnTimeoutMs: 300000, retries: 2, effort: "", toolResultMaxChars: 8000 }, images: { vision: true } });

test("openai：工具循环 → 只回传协议字段 → 最终文本；工具失败转成文本不中断", async () => {
  const bodies = [];
  const replies = [
    { choices: [{ message: { role: "assistant", content: null, reasoning_content: "内部推理", tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"s":"hi"}' } }, { id: "c2", type: "function", function: { name: "boom", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { choices: [{ message: { role: "assistant", content: "  搞定  </think_never_used_abc>" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3 } },  // 漏出的思考标记在 runner 就清掉
  ];
  const agent = makeAgent(baseCfg("openai"), log);
  const r = await withFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, () => agent.run({ system: "S", userText: "U", tools: [echoTool, failTool] }));
  assert.deepEqual(r, { text: "搞定", reason: "stop", usage: { input: 30, output: 8 }, turns: 2, toolCalls: 2, visionDropped: false });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].messages[0].content, "S");
  assert.equal(bodies[0].tool_choice, "auto");
  const echoed = bodies[1].messages[2];
  assert.deepEqual(Object.keys(echoed).sort(), ["content", "role", "tool_calls"]); // reasoning_content 不回传
  assert.deepEqual(bodies[1].messages[3], { role: "tool", tool_call_id: "c1", content: "echo:hi" });
  assert.match(bodies[1].messages[4].content, /^错误：炸了/);
});

test("openai：4xx 不重试直接抛；5xx 重试；图片被拒退化纯文字", async () => {
  const agent = makeAgent(baseCfg("openai"), log);
  let calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return json({ error: { message: "bad key" } }, 401); }, () => agent.run({ system: "S", userText: "U", tools: [] })), /HTTP 401.*bad key/);
  assert.equal(calls, 1);
  calls = 0;
  const r = await withFetch(async () => (++calls < 3 ? json({}, 503) : json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })), () => agent.run({ system: "S", userText: "U", tools: [] }));
  assert.equal(r.text, "ok"); assert.equal(calls, 3);
  const bodies = [];
  const r2 = await withFetch(async (_u, init) => { const b = JSON.parse(init.body); bodies.push(b); return Array.isArray(b.messages[1].content) ? json({ error: { message: "image_url not supported" } }, 400) : json({ choices: [{ message: { content: "文字ok" }, finish_reason: "stop" }] }); },
    () => agent.run({ system: "S", userText: "U", images: [{ url: "https://x/a.png" }], tools: [] }));
  assert.equal(r2.text, "文字ok");
  assert.ok(Array.isArray(bodies[0].messages[1].content) && typeof bodies[1].messages[1].content === "string");
});

test("openai：超过 maxTurns 返回 max-turns；effort 有值才传", async () => {
  const cfg = baseCfg("openai"); cfg.agent.maxTurns = 2; cfg.agent.effort = "high";
  const agent = makeAgent(cfg, log);
  let calls = 0;
  const r = await withFetch(async (_u, init) => { calls++; assert.equal(JSON.parse(init.body).reasoning_effort, "high"); return json({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "echo", arguments: "{}" } }] } }] }); }, () => agent.run({ system: "S", userText: "U", tools: [echoTool] }));
  assert.equal(r.reason, "max-turns"); assert.equal(calls, 2);
});

test("openai：服务端只认 max_completion_tokens 时自动切换字段、不算一轮，且进程内记住", async () => {
  const cfg = baseCfg("openai"); cfg.agent.maxTurns = 1;
  const agent = makeAgent(cfg, log);
  const bodies = [];
  const impl = async (_u, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if ("max_tokens" in b) return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400);
    return json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  };
  const r = await withFetch(impl, () => agent.run({ system: "S", userText: "U", tools: [] }));
  assert.equal(r.text, "ok");  // maxTurns 1 也能成功：换字段的那次不算一轮
  assert.deepEqual(bodies.map((b) => [b.max_tokens, b.max_completion_tokens]), [[100, undefined], [undefined, 100]]);
  await withFetch(impl, () => agent.run({ system: "S", userText: "U", tools: [] }));
  assert.equal(bodies.length, 3);  // 第二次直接用新字段，不再试错
  const other = makeAgent(cfg, log);
  await assert.rejects(withFetch(async () => json({ error: { message: "bad request" } }, 400), () => other.run({ system: "S", userText: "U", tools: [] })), /bad request/);  // 别的 4xx 照旧直接抛
});

test("anthropic：agent.thinking 有值才传；预算只截短本轮刚生成的工具结果，已发过的历史一字不改", async () => {
  const cfg = baseCfg("anthropic"); cfg.agent.thinking = "adaptive"; cfg.agent.maxInputTokens = 900;
  const agent = makeAgent(cfg, log);
  const big = { name: "big", description: "大结果", input_schema: { type: "object", properties: {} }, async run() { return "数".repeat(2000); } };
  const bodies = [];
  const replies = [
    { content: [{ type: "tool_use", id: "t1", name: "big", input: {} }], stop_reason: "tool_use", usage: {} },
    { content: [{ type: "tool_use", id: "t2", name: "big", input: {} }], stop_reason: "tool_use", usage: {} },
    { content: [{ type: "text", text: "完" }], stop_reason: "end_turn", usage: {} },
  ];
  const r = await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, () => agent.run({ system: "S", userText: "U", tools: [big] }));
  assert.equal(r.text, "完");
  assert.deepEqual(bodies[0].thinking, { type: "adaptive" });
  const first = bodies[1].messages[2].content[0].content;  // 第一轮工具结果：发出前被截短
  assert.ok(first.length < 2000 && first.endsWith("…（本条工具结果因超出输入预算已截短）"));
  assert.equal(bodies[2].messages[2].content[0].content, first);  // 第二轮请求里它原样保留，不再改
  assert.ok(bodies[2].messages[4].content[0].content.length < 2000);  // 新一轮的结果同样只在发出前截短
  const plain = makeAgent(baseCfg("anthropic"), log);
  await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json({ content: [{ type: "text", text: "x" }], stop_reason: "end_turn", usage: {} }); }, () => plain.run({ system: "S", userText: "U", tools: [] }));
  assert.ok(!("thinking" in bodies.at(-1)));
});

test("anthropic：system 带 cache_control、tool_use 循环、thinking 块原样回传、is_error 标记", async () => {
  const bodies = [];
  const replies = [
    { content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "我查一下" }, { type: "tool_use", id: "t1", name: "echo", input: { s: "a" } }, { type: "tool_use", id: "t2", name: "boom", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } },
    { content: [{ type: "text", text: "结果是 a" }], stop_reason: "end_turn", usage: { input_tokens: 15, output_tokens: 3 } },
  ];
  const cfg = baseCfg("anthropic"); cfg.agent.effort = "low";
  const agent = makeAgent(cfg, log);
  const r = await withFetch(async (url, init) => { bodies.push([url, init]); return json(replies.shift()); }, () => agent.run({ system: "S", userText: "U", tools: [echoTool, failTool] }));
  assert.deepEqual(r, { text: "结果是 a", reason: "end_turn", usage: { input: 25, output: 7, cacheRead: 8, cacheWrite: 2 }, turns: 2, toolCalls: 2, visionDropped: false });
  assert.equal(bodies[0][0], "https://llm/v1/messages");
  assert.equal(bodies[0][1].headers["x-api-key"], "k");
  const b0 = JSON.parse(bodies[0][1].body);
  assert.deepEqual(b0.system, [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(b0.output_config, { effort: "low" });
  assert.ok(!("run" in b0.tools[0]));
  const b1 = JSON.parse(bodies[1][1].body);
  assert.equal(b1.messages[1].content[0].type, "thinking"); // 原样回传
  assert.deepEqual(b1.messages[2].content, [{ type: "tool_result", tool_use_id: "t1", content: "echo:a" }, { type: "tool_result", tool_use_id: "t2", content: "错误：炸了", is_error: true }]);
});

test("anthropic：refusal 返回 category；图片走 base64 块", async () => {
  const agent = makeAgent(baseCfg("anthropic"), log);
  const bodies = [];
  const r = await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, usage: {} }); },
    () => agent.run({ system: "S", userText: "U", images: [{ mediaType: "image/png", base64: "AAAA" }], tools: [] }));
  assert.equal(r.reason, "refusal"); assert.equal(r.category, "cyber"); assert.equal(r.text, null);
  assert.deepEqual(bodies[0].messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
});

test("openai：预算紧时更早轮次的工具结果压成占位，本轮刚返回的只截短、不压掉", async () => {
  const cfg = baseCfg("openai"); cfg.agent.maxInputTokens = 900;
  const big = { name: "big", description: "大结果", input_schema: { type: "object", properties: {} }, async run() { return "数".repeat(2000); } };
  const bodies = [];
  const replies = [
    { choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "big", arguments: "{}" } }] } }] },
    { choices: [{ message: { tool_calls: [{ id: "c2", type: "function", function: { name: "big", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "完" }, finish_reason: "stop" }] },
  ];
  const r = await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, () => makeAgent(cfg, log).run({ system: "S", userText: "U", tools: [big] }));
  assert.equal(r.text, "完");
  const fresh1 = bodies[1].messages[3].content;
  assert.ok(fresh1.startsWith("数".repeat(200)) && fresh1.endsWith("…（本条工具结果因超出输入预算已截短）"));  // 第一轮的结果：截短但还在
  assert.match(bodies[2].messages[3].content, /^（较早的工具结果因超出输入预算已省略）$/);  // 到第二轮它成了旧的，才压成占位
  assert.ok(bodies[2].messages[5].content.startsWith("数".repeat(200)));  // 第二轮刚返回的照样留着
});

test("429 限流：按 Retry-After（封顶）或更长的退避再试，不是隔半秒连撞；等不到 deadline 前就放弃", async () => {
  const waits = [];
  let t = Date.now(), n = 0;
  const limited = (headers = {}) => new Response(JSON.stringify({ error: { message: "当前分组上游负载已饱和" } }), { status: 429, headers });
  const ok = json({ choices: [{ message: { content: "好了" }, finish_reason: "stop" }] });
  const r = await withFetch(async () => { waits.push(Date.now() - t); t = Date.now(); return ++n === 1 ? limited({ "retry-after": "1" }) : ok; }, () => makeAgent(baseCfg("openai"), log).run({ system: "S", userText: "U", tools: [] }));
  assert.equal(r.text, "好了");
  assert.ok(waits[1] >= 900, `按 Retry-After 等了 ${waits[1]}ms`);
  const t0 = Date.now();
  const r2 = await withFetch(async () => limited(), () => makeAgent(baseCfg("openai"), log).run({ system: "S", userText: "U", tools: [], deadlineMs: 300 }));
  assert.equal(r2.reason, "timeout");  // 限流等不到头：按一轮时限到了收场，私聊再走兜底
  assert.ok(Date.now() - t0 < 2000, "等不到 deadline 前就不再干等 4 秒");
});

test("同一个工具这一轮报了同样的错：第二次起告诉模型别再调（换参数重试也一样），两种协议都是", async () => {
  const boom = { name: "boom", description: "总失败", input_schema: { type: "object", properties: { n: { type: "number" } } }, async run() { throw new Error("做不了"); } };
  const oa = [1, 2].map((n) => ({ choices: [{ message: { tool_calls: [{ id: `c${n}`, type: "function", function: { name: "boom", arguments: `{"n":${n}}` } }] } }] }));
  oa.push({ choices: [{ message: { content: "算了" }, finish_reason: "stop" }] });
  const bodies = [];
  await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json(oa.shift()); }, () => makeAgent(baseCfg("openai"), log).run({ system: "S", userText: "U", tools: [boom] }));
  const results = bodies.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.equal(results[0], "错误：做不了");
  assert.match(results[1], /^错误：做不了\n（这个错误这一轮已经出现过了.*别再调这个工具/);
  const an = [1, 2].map((n) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: `u${n}`, name: "boom", input: { n } }], usage: {} }));
  an.push({ stop_reason: "end_turn", content: [{ type: "text", text: "算了" }], usage: {} });
  const abodies = [];
  await withFetch(async (_u, init) => { abodies.push(JSON.parse(init.body)); return json(an.shift()); }, () => makeAgent(baseCfg("anthropic"), log).run({ system: "S", userText: "U", tools: [boom] }));
  const ares = abodies.at(-1).messages.filter((m) => m.role === "user" && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
  assert.deepEqual(ares.map((b) => b.is_error), [true, true]);
  assert.ok(!ares[0].content.includes("别再调") && ares[1].content.includes("别再调"));
});

test("openai：工具参数不是合法 JSON / 不是对象就不执行，回一个出错的结果让模型重来", async () => {
  const seen = [];
  const spy = { name: "remember", description: "记", input_schema: { type: "object", properties: { text: { type: "string" } } }, async run(input) { seen.push(input); return "ok"; } };
  const bodies = [];
  const replies = [
    { choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "remember", arguments: '{"text":"周五聚' } }, { id: "c2", type: "function", function: { name: "remember", arguments: '["x"]' } }] } }] },
    { choices: [{ message: { tool_calls: [{ id: "c3", type: "function", function: { name: "remember", arguments: '{"text":"周五聚餐"}' } }] } }] },
    { choices: [{ message: { content: "记好了" }, finish_reason: "stop" }] },
  ];
  const r = await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, () => makeAgent(baseCfg("openai"), log).run({ system: "S", userText: "U", tools: [spy] }));
  assert.equal(r.text, "记好了");
  assert.equal(r.toolCalls, 3);
  assert.deepEqual(seen, [{ text: "周五聚餐" }]);  // 坏参数的两次根本没执行，不会把 "undefined" 记进去
  const [bad, notObj] = bodies[1].messages.slice(3);
  assert.equal(bad.tool_call_id, "c1");
  assert.match(bad.content, /^错误：参数不是合法 JSON：.*收到的是：\{"text":"周五聚）。按工具说明的参数格式重新调用一次$/);
  assert.equal(notObj.tool_call_id, "c2");
  assert.match(notObj.content, /^错误：参数必须是一个 JSON 对象/);
});

test("anthropic：tool_use 的 input 不是对象同样不执行，结果带 is_error", async () => {
  const seen = [];
  const spy = { name: "echo", description: "", input_schema: { type: "object", properties: {} }, async run(input) { seen.push(input); return "ok"; } };
  const bodies = [];
  const replies = [
    { content: [{ type: "tool_use", id: "t1", name: "echo", input: ["abc"] }], stop_reason: "tool_use", usage: {} },
    { content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: {} },
  ];
  await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, () => makeAgent(baseCfg("anthropic"), log).run({ system: "S", userText: "U", tools: [spy] }));
  assert.deepEqual(seen, []);
  assert.equal(bodies[1].messages[2].content[0].is_error, true);
  assert.match(bodies[1].messages[2].content[0].content, /参数必须是一个 JSON 对象/);
});

test("工具结果按 toolResultMaxChars 截断时不切开 emoji；system / user / 工具报错里已有的半个代理对进请求前补齐", async () => {
  const cfg = baseCfg("anthropic"); cfg.agent.toolResultMaxChars = 5;
  const emoji = { name: "e", description: "", input_schema: { type: "object", properties: {} }, async run() { return "abcd😂😂"; } };  // 第 5 个 UTF-16 单元是 😂 的高位
  const broken = { name: "b", description: "", input_schema: { type: "object", properties: {} }, async run() { throw new Error("平台报错摘要\uD83D"); } };
  const bodies = [];
  const replies = [
    { content: [{ type: "tool_use", id: "t1", name: "e", input: {} }, { type: "tool_use", id: "t2", name: "b", input: {} }], stop_reason: "tool_use", usage: {} },
    { content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: {} },
  ];
  await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json(replies.shift()); }, () => makeAgent(cfg, log).run({ system: "S\uD83D", userText: "U\uDE02", tools: [emoji, broken] }));
  const [cut, err] = bodies[1].messages[2].content;
  assert.equal(cut.content, "abcd\n…（工具结果超过 5 字已截断）");
  assert.ok(err.content.isWellFormed() && err.content.startsWith("错误：平台报错摘要"));
  assert.ok(bodies[0].system[0].text.isWellFormed());
  assert.ok(bodies[0].messages[0].content.at(-1).text.isWellFormed());
});

test("图片类型模型不认（bmp）就整轮纯文字：不发 image 块、去掉头像附图说明、补一句看不到图", async () => {
  const userText = `U\n</trigger>\n\n${AVATAR_NOTE}\n\n当前时间：x`;
  for (const protocol of ["openai", "anthropic"]) {
    const bodies = [];
    const reply = protocol === "openai" ? { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } : { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} };
    const r = await withFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return json(reply); },
      () => makeAgent(baseCfg(protocol), log).run({ system: "S", userText, images: [{ mediaType: "image/png", base64: "AAAA" }, { mediaType: "image/bmp", base64: "Qk0=" }], tools: [] }));
    assert.equal(r.visionDropped, true, protocol);
    const content = protocol === "openai" ? bodies[0].messages[1].content : bodies[0].messages[0].content;
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
    assert.ok(blocks.every((b) => b.type === "text"), protocol);
    const text = blocks.map((b) => b.text).join("");
    assert.ok(!text.includes("附图说明"), protocol);
    assert.match(text, /<\/trigger>\n\n当前时间：x\n\n（本轮的图片没能送进模型/);
  }
});

test("图片被拒：纯文字重试不占 maxTurns、去掉头像附图说明；anthropic 在工具轮之后才被拒就不改写历史、直接失败", async () => {
  const userText = `U\n\n${AVATAR_NOTE}\n\n当前时间：x`;
  const img = [{ mediaType: "image/png", base64: "AAAA" }];
  const oaCfg = baseCfg("openai"); oaCfg.agent.maxTurns = 1;
  const oaBodies = [];
  const r1 = await withFetch(async (_u, init) => { const b = JSON.parse(init.body); oaBodies.push(b); return Array.isArray(b.messages[1].content) ? json({ error: { message: "image input not supported" } }, 400) : json({ choices: [{ message: { content: "文字ok" }, finish_reason: "stop" }] }); },
    () => makeAgent(oaCfg, log).run({ system: "S", userText, images: img, tools: [] }));
  assert.equal(r1.text, "文字ok"); assert.equal(r1.turns, 1); assert.equal(r1.visionDropped, true);
  assert.ok(!oaBodies[1].messages[1].content.includes("附图说明"));

  const anCfg = baseCfg("anthropic"); anCfg.agent.maxTurns = 1;
  const anBodies = [];
  const r2 = await withFetch(async (_u, init) => { const b = JSON.parse(init.body); anBodies.push(b); return Array.isArray(b.messages[0].content) ? json({ type: "error", error: { message: "image source not supported" } }, 400) : json({ content: [{ type: "text", text: "文字ok" }], stop_reason: "end_turn", usage: {} }); },
    () => makeAgent(anCfg, log).run({ system: "S", userText, images: img, tools: [] }));
  assert.equal(r2.text, "文字ok"); assert.equal(r2.visionDropped, true);
  assert.match(anBodies[1].messages[0].content, /^U\n\n当前时间：x\n\n（本轮的图片没能送进模型/);

  const late = [];
  const replies = [
    { content: [{ type: "tool_use", id: "t1", name: "echo", input: { s: "a" } }], stop_reason: "tool_use", usage: {} },
  ];
  await assert.rejects(withFetch(async (_u, init) => { late.push(JSON.parse(init.body)); return replies.length ? json(replies.shift()) : json({ type: "error", error: { message: "Could not process image" } }, 400); },
    () => makeAgent(baseCfg("anthropic"), log).run({ system: "S", userText, images: img, tools: [echoTool] })), /Could not process image/);
  assert.equal(late.length, 2);  // 不再发第三次纯文字重试
  assert.equal(late[1].messages[0].content[0].type, "image");  // 发过的首条原样，没被改写
});

test("一轮总时限：模型请求挂住、工具卡住都在时限内收场，返回 text:null、reason timeout", async () => {
  const hang = (_u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  for (const protocol of ["openai", "anthropic"]) {
    const t0 = Date.now();
    const r = await withFetch(hang, () => makeAgent(baseCfg(protocol), log).run({ system: "S", userText: "U", tools: [], deadlineMs: 80 }));
    assert.equal(r.text, null, protocol); assert.equal(r.reason, "timeout", protocol); assert.equal(r.turns, 0);
    assert.ok(Date.now() - t0 < 3000, protocol);  // 单次超时 5 秒、重试 2 次，本来要十几秒
  }
  const stuck = { name: "stuck", description: "", input_schema: { type: "object", properties: {} }, run: () => new Promise(() => {}) };
  const reply = { choices: [{ message: { tool_calls: [{ id: "c", type: "function", function: { name: "stuck", arguments: "{}" } }] } }] };
  const r2 = await withFetch(async () => json(reply), () => makeAgent(baseCfg("openai"), log).run({ system: "S", userText: "U", tools: [stuck], deadlineMs: 80 }));
  assert.equal(r2.reason, "timeout"); assert.equal(r2.text, null); assert.equal(r2.turns, 1);
});
