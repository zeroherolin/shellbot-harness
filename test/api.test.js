import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApi, sendTarget, resolveToken } from "../src/api.js";

const NET = { sendTimeoutMs: 15000, sendRetries: 2, apiTimeoutMs: 30000 };
const withFetch = async (impl, fn) => {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const ok = (data, meta) => json({ success: true, code: 0, data, ...(meta ? { meta } : {}) });
const fail = (status, error) => json({ success: false, code: status, error }, status);

test("resolveToken：配置 → 环境变量 → 都没有时报可操作的错；不再读 shellbot-cli 的全局凭证", () => {
  const saved = process.env.SHELLBOT_TOKEN;
  try {
    process.env.SHELLBOT_TOKEN = "env-token";
    assert.equal(resolveToken({ token: "cfg-token" }), "cfg-token");
    assert.equal(resolveToken({ token: "" }), "env-token");
    delete process.env.SHELLBOT_TOKEN;
    assert.throws(() => resolveToken({ token: "" }), /在配置里填 token/);  // 哪怕本机装过 shellbot-cli 也不去读
  } finally {
    if (saved === undefined) delete process.env.SHELLBOT_TOKEN; else process.env.SHELLBOT_TOKEN = saved;
  }
});

test("makeApi：token 里有换行 / 控制字符直接拒绝且报错不带 token；任何错误信息里的 token 都打码", async () => {
  assert.throws(() => makeApi({ host: "https://h", token: "abc\ndef", net: NET }), (e) => /控制字符/.test(e.message) && !e.message.includes("abc"));
  const api = makeApi({ host: "https://h", token: "sekret", net: { ...NET, sendRetries: 0 } });
  await assert.rejects(withFetch(async () => { throw new TypeError('Headers.append: "Token sekret" is an invalid header value.'); }, () => api.status(1)), (e) => !e.message.includes("sekret") && /\*\*\*/.test(e.message));
  await assert.rejects(withFetch(async () => fail(401, { message: "bad token sekret" }), () => api.status(1)), (e) => !e.message.includes("sekret"));
});

test("makeApi：Token 鉴权、路径与 query 拼接（空值不带）；list 返回 rows + pagination，单条返回 data", async () => {
  const api = makeApi({ host: "https://h/", token: "t", net: NET });
  const seen = [];
  const r = await withFetch(async (url, init) => { seen.push([url, init]); return ok([{ _id: "a" }], { pagination: { page: 2, pageSize: 50, total: 120, hasMore: true } }); },
    () => api.history(1, { type: "room", wxid: "g@chatroom", page: 2, pageSize: 50, startTime: undefined, endTime: "" }));
  assert.equal(seen[0][0], "https://h/aiapi/v1/bots/1/history?type=room&wxid=g%40chatroom&page=2&pageSize=50");
  assert.equal(seen[0][1].method, "GET");
  assert.equal(seen[0][1].headers.authorization, "Token t");
  assert.equal(seen[0][1].body, undefined);
  assert.deepEqual(r, { rows: [{ _id: "a" }], pagination: { page: 2, pageSize: 50, total: 120, hasMore: true } });
  const bot = await withFetch(async (url) => { seen.push([url]); return ok({ id: "hashed", name: "helper" }); }, () => api.bot(1));
  assert.equal(seen[1][0], "https://h/aiapi/v1/bots/1");
  assert.deepEqual(bot, { id: "hashed", name: "helper" });
  const rooms = await withFetch(async () => ok(null), () => api.rooms(1, { keyword: "甲" }));
  assert.deepEqual(rooms, { rows: [], pagination: null });  // data 不是数组也给空数组
});

test("makeApi：4xx 与平台标 retryable:false 不重试；5xx / 429 / retryable:true 重试；错误信息带 type", async () => {
  const api = makeApi({ host: "https://h", token: "t", net: NET });
  let calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return fail(404, { type: "NOT_FOUND", message: "Bot 1 not found", retryable: false }); }, () => api.bot(1)), /GET \/bots\/1 失败 HTTP 404 NOT_FOUND: Bot 1 not found/);
  assert.equal(calls, 1);
  calls = 0;
  const r = await withFetch(async () => (++calls < 3 ? fail(503, { type: "UPSTREAM", message: "down" }) : ok({ x: 1 })), () => api.status(1));
  assert.deepEqual(r, { x: 1 }); assert.equal(calls, 3);
  calls = 0;
  await withFetch(async () => (++calls < 2 ? fail(429, { message: "slow down" }) : ok({})), () => api.status(1));
  assert.equal(calls, 2);
  calls = 0;
  await withFetch(async () => (++calls < 2 ? fail(400, { type: "TEMP", message: "again", retryable: true }) : ok({})), () => api.status(1));
  assert.equal(calls, 2);  // 平台明说可重试就重试
  calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return new Response("<html>", { status: 200 }); }, () => api.status(1)), /HTTP 200/);  // 2xx 但不是信封（域名错 / 代理页）：重试无益，直接抛
  assert.equal(calls, 1);
});

test("makeApi.send：图片 url 解码后再传（平台会再编码）、用 sendTimeoutMs；机器人离线 409 不重试", async () => {
  const api = makeApi({ host: "https://h", token: "t", net: NET });
  const seen = [];
  const r = await withFetch(async (url, init) => { seen.push([url, init]); return ok({ success: true, async: true }); },
    () => api.send(1, sendTarget({ id: "g@chatroom", isGroup: true }), [{ type: 1, content: "hi" }, { type: 10, url: "https://oss/%E5%9B%BE.png" }]));
  assert.deepEqual(r, { success: true, async: true });
  assert.equal(seen[0][0], "https://h/aiapi/v1/bots/1/messages/send");
  assert.equal(seen[0][1].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0][1].body), { target: { id: "g@chatroom", type: "room" }, messages: [{ type: 1, content: "hi" }, { type: 10, url: "https://oss/图.png" }] });
  let calls = 0;
  const sendOne = () => api.send(1, sendTarget({ id: "wxid_a", isGroup: false }), [{ type: 1, content: "x" }]);
  await assert.rejects(withFetch(async () => { calls++; return fail(409, { type: "DEVICE_OFFLINE", message: "Bot 1 is offline", retryable: false }); }, sendOne), /DEVICE_OFFLINE/);
  assert.equal(calls, 1);
  // 非幂等：502 / 504 / 网络错误后端可能已经收下，不重发；429 / 503 肯定没处理才重试
  calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return fail(502, { message: "bad gateway" }); }, sendOne), /HTTP 502/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withFetch(async () => { calls++; throw new TypeError("fetch failed"); }, sendOne), /结果未知，不重发/);
  assert.equal(calls, 1);
  calls = 0;
  assert.deepEqual(await withFetch(async () => (++calls < 2 ? fail(503, { message: "busy" }) : ok({ success: true })), sendOne), { success: true });
  assert.equal(calls, 2);
  calls = 0;
  await withFetch(async () => (++calls < 2 ? fail(429, { message: "slow" }) : ok({})), sendOne);
  assert.equal(calls, 2);
});

test("makeApi.upload：multipart 带 apiSecret 与文件，返回平台托管地址；code 非 0 或缺 path 报错", async () => {
  const api = makeApi({ host: "https://h", token: "t", net: NET });
  const seen = [];
  const url = await withFetch(async (u, init) => { seen.push([u, init]); return json({ code: 0, message: "success", data: { path: "https://h/uploads/1/chat/bot_chat_file_x_a.png" } }); },
    () => api.upload({ apiSecret: "s", buffer: Buffer.from("png"), filename: "a.png", mediaType: "image/png" }));
  assert.equal(url, "https://h/uploads/1/chat/bot_chat_file_x_a.png");
  assert.equal(seen[0][0], "https://h/api/v1/client/chat/upload");
  const form = seen[0][1].body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("apiSecret"), "s");
  assert.equal(form.get("file").name, "a.png");
  assert.equal(form.get("file").type, "image/png");
  await assert.rejects(withFetch(async () => json({ code: 401, message: "用户信息验证失败" }), () => api.upload({ apiSecret: "bad", buffer: Buffer.alloc(1), filename: "a.png", mediaType: "image/png" })), /上传失败.*用户信息验证失败/);
});

test("sendTarget：群 room、私聊 contact", () => {
  assert.deepEqual(sendTarget({ id: "g@chatroom", isGroup: true }), { id: "g@chatroom", type: "room" });
  assert.deepEqual(sendTarget({ id: "wxid_a", isGroup: false }), { id: "wxid_a", type: "contact" });
});

test("makeApi.syncContacts：走通用事件接口并带 target:system（专门的 sync-contacts 路由发出的事件 puppet 不认）", async () => {
  const api = makeApi({ host: "https://h", token: "t", net: NET });
  const seen = [];
  await withFetch(async (url, init) => { seen.push([url, init]); return ok({ message: "sent" }); }, () => api.syncContacts(7));
  assert.equal(seen[0][0], "https://h/aiapi/v1/bots/7/event");
  assert.equal(seen[0][1].method, "POST");
  assert.deepEqual(JSON.parse(seen[0][1].body), { event: "async", data: { target: "system" } });
});
