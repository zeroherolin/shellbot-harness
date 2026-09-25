import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeInbound, openclawOutbound, fetchBroker, mqttLoop, isOwnRecord, loadBot, fetchHistory, findAuthorImage, platformSafeText, isPlatformUrl, tlsUrl, publishError, normalizeClawInbound } from "../src/platform.js";
import { sniffImageType, fetchImageData, checkStickers, isPrivateAddress, VISION_MEDIA_TYPES } from "../src/fetch-image.js";
import { stickerUrl, matchOssUrl, wxImageKey, isOssUrl, findOssUrl, parseStickerEvents, makeStickerFeed } from "../src/puppet-log.js";
import { toMillis, isImageMsg, decodedUrl, encodedUrl, retry, fatal } from "../src/util.js";
const NET = { sendTimeoutMs: 15000, sendRetries: 2, platformTimeoutMs: 10000, apiTimeoutMs: 30000, mqttKeepalive: 30, mqttConnectTimeoutMs: 15000, reconnectBaseMs: 2000, reconnectMaxMs: 60000 };
const IMG = { timeoutMs: 15000, maxBytes: 5000000, retries: 3, allowPrivate: true };  // mock fetch 的测试不做 DNS 校验

test("表情包尺寸：OSS 地址挂缩放参数（替换已有 x-oss-process、保留其它 query）；非 OSS 原样", () => {
  const oss = "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/a_/%E5%9B%BE.png?x-oss-process=image/format,png&k=v";
  const std = { edge: 240, quality: 85 };
  assert.equal(stickerUrl(oss, std), "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/a_/图.png?k=v&x-oss-process=image/resize,m_lfit,w_240,h_240/format,jpg/quality,q_85");
  assert.equal(stickerUrl("https://bucket.oss-cn-hangzhou.aliyuncs.com/img/a_/图.png", { edge: 320, quality: 70 }), "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/a_/图.png?x-oss-process=image/resize,m_lfit,w_320,h_320/format,jpg/quality,q_70");
  assert.equal(stickerUrl("https://x/a.png?w=1", std), "https://x/a.png?w=1");
  assert.equal(isOssUrl("https://bucket.oss-cn-hangzhou.aliyuncs.com/x"), true);
  assert.equal(isOssUrl("https://up/uploads/x"), false);
});
test("wxImageKey / matchOssUrl：按「微信图片_时间戳」尾巴把 uploads 地址对回 puppet 日志里的 OSS remoteUrl", () => {
  assert.equal(wxImageKey("https://up/x/bot_chat_file_1_2_uuid_微信图片_20260922131854.png?q=1"), "微信图片_20260922131854.png");
  assert.equal(wxImageKey("https://up/x/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260922131854.png"), "微信图片_20260922131854.png");
  assert.equal(wxImageKey("https://up/x/logo.png"), null);
  const lines = [
    "  remoteUrl: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/img/1_/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260922130553.png',",
    "  version: '1.5.5',",
    "  remoteUrl: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/img/2_/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260922131854.png',",
  ];
  assert.equal(matchOssUrl(lines, "https://up/uploads/x/bot_chat_file_1_2_uuid_微信图片_20260922131854.png"), "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/2_/微信图片_20260922131854.png");
  assert.equal(matchOssUrl(lines, "https://up/uploads/x/bot_chat_file_1_2_uuid_%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260922130553.png"), "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/1_/微信图片_20260922130553.png");
  assert.equal(matchOssUrl(lines, "https://up/uploads/x/微信图片_20260101000000.png"), null);
  assert.equal(matchOssUrl(lines, "https://up/uploads/x/logo.png"), null);
  assert.equal(matchOssUrl([], "https://up/uploads/x/微信图片_20260922131854.png"), null);
});

test("出站 url 解码 / 自用 url 单次编码（平台会再编码一次）", () => {
  const raw = "https://oss/a_/微信图片_1.png?x-oss-process=image/format,png";
  const once = "https://oss/a_/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_1.png?x-oss-process=image/format,png";
  assert.equal(decodedUrl(once), raw);
  assert.equal(decodedUrl(raw), raw);
  assert.equal(decodedUrl("https://x/a.png"), "https://x/a.png");
  assert.equal(decodedUrl("https://x/%E0%A4%A"), "https://x/%E0%A4%A"); // 非法序列原样返回
  assert.equal(encodedUrl(raw), once);
  assert.equal(encodedUrl(once), once); // 不会二次编码
  assert.equal(encodedUrl("https://x/a%2Fb.png?s=ab%2B%3D"), "https://x/a%2Fb.png?s=ab%2B%3D"); // 保留字转义与签名参数不动
  assert.equal(encodedUrl("https://x/图 片.png"), "https://x/%E5%9B%BE%20%E7%89%87.png");
});

test("入站规范化（聊天记录）", () => {
  const rec = JSON.stringify({ _id: "abc", conversationId: "g@chatroom", recordType: "room", chatUserId: "wxid_u", chatUserName: "U", robotId: "wxid_bot", isRobotAnswer: false, contentType: "文字", content: "hi", timestamp: 1700000000, msgId: "mid" });
  const m = normalizeInbound("chat/1/g@chatroom", rec, 1);
  assert.equal(m.id, "mid");
  assert.equal(m.conv.id, "g@chatroom");
  assert.equal(m.isGroup, true);
  assert.equal(m.sender.id, "wxid_u");
  assert.equal(m.text, "hi");
  assert.equal(m.isMine, false);
  assert.equal(m.ts, 1700000000 * 1000);
  assert.ok(Math.abs(m.receivedAt - Date.now()) < 1000);  // 排队超时按本地收到时间
  assert.equal(m.mention, false);
});
test("入站：机器人自己的消息（isRobotAnswer 或 chatUserId===robotId）", () => {
  const mk = (o) => normalizeInbound("chat/1/g@chatroom", JSON.stringify({ conversationId: "g@chatroom", recordType: "room", chatUserId: "wxid_bot", contentType: "文字", content: "x", ...o }), 1);
  assert.equal(mk({ isRobotAnswer: true }).isMine, true);
  assert.equal(mk({ isRobotAnswer: "True" }).isMine, true);  // 平台会给字符串布尔
  assert.equal(mk({ robotId: "wxid_bot" }).isMine, true);
  assert.equal(mk({ robotId: "wxid_other" }).isMine, false);
});
test("isOwnRecord：历史行没带 robotId 时用运行时学到的机器人 wxid 兜底（手机上手动发的没有 isRobotAnswer）", () => {
  assert.equal(isOwnRecord({ chatUserId: "wxid_bot", isRobotAnswer: "True" }), true);
  assert.equal(isOwnRecord({ chatUserId: "wxid_bot", robotId: "wxid_bot" }), true);
  assert.equal(isOwnRecord({ chatUserId: "wxid_bot" }), false);
  assert.equal(isOwnRecord({ chatUserId: "wxid_bot" }, "wxid_bot"), true);
  assert.equal(isOwnRecord({ chatUserId: "wxid_u" }, "wxid_bot"), false);
});
test("入站：私聊会话名回退到发送者", () => {
  const m = normalizeInbound("chat/1/wxid_u", JSON.stringify({ conversationId: "wxid_u", recordType: "contact", chatUserId: "wxid_u", chatUserName: "小明", contentType: "文字", content: "x" }), 1);
  assert.equal(m.isGroup, false);
  assert.equal(m.conv.name, "小明");
});
test("入站：图片以「文件」类型进来靠 isImage 判定；非 http url 丢弃", () => {
  const mk = (o) => normalizeInbound("chat/1/g@chatroom", JSON.stringify({ conversationId: "g@chatroom", recordType: "room", chatUserId: "u", contentType: "文件", ...o }), 1);
  assert.equal(mk({ isImage: "True", url: "https://x/a" }).isImage, true);
  assert.equal(mk({ isImage: true, url: "ftp://x/a" }).url, null);
  assert.equal(mk({ isImage: true, url: "ftp://x/a" }).isImage, false);
});
test("入站：h5 卡片正文用标题｜描述，文件用文件名，图片仍用链接", () => {
  const mk = (o) => normalizeInbound("chat/1/g@chatroom", JSON.stringify({ conversationId: "g@chatroom", recordType: "room", chatUserId: "u", ...o }), 1);
  const h5 = mk({ contentType: "h5卡片", content: "https://x/article", url: "https://x/article", title: "标题", description: "描述" });
  assert.equal(h5.text, "标题｜描述"); assert.equal(h5.url, "https://x/article"); assert.equal(h5.type, "h5卡片");
  assert.equal(mk({ contentType: "h5卡片", content: "https://x/a", url: "https://x/a", title: "只有标题" }).text, "只有标题");
  assert.equal(mk({ contentType: "文件", content: "https://up/x.pdf", url: "https://up/x.pdf", fileName: "周报.pdf" }).text, "周报.pdf");
  const img = mk({ contentType: "文件", content: "https://up/微信图片_1.png", url: "https://up/微信图片_1.png", fileName: "微信图片_1.png", isImage: true });
  assert.equal(img.isImage, true); assert.equal(img.text, "https://up/微信图片_1.png");  // 图片行不显示正文，保持原样
});

test("loadBot：昵称优先取微信名，其次后台别名；两个开关按平台的实际条件算；id 用配置里的数字", async () => {
  const mk = (row) => loadBot({ bot: async () => row }, 7);
  assert.deepEqual(await mk({ id: "hashed", name: "helper", accountName: "小助手账号", robotId: null, apiSecret: "s", avatar: "/uploads/1/bot_avatar_1_7_helper.jpeg", clawConfig: { open: true }, recordConfig: { open: true, userGroupId: "g" } }),
    { id: 7, name: "helper", robotId: null, apiSecret: "s", avatar: "/uploads/1/bot_avatar_1_7_helper.jpeg", clawOpen: true, clawGroup: false, clawText: false, clawMedia: false, recordOpen: true });
  // OpenClaw 入站：开着、配了范围组，再分别看文字 / 媒体转发开关；没配范围组一条都不推（转发开关开着也没用）
  const claw = async (c) => { const x = await mk({ clawConfig: c }); return [x.clawGroup, x.clawText, x.clawMedia]; };
  assert.deepEqual(await claw({ open: true, userGroupId: "g", forwardAllMsg: true, forwardMediaMsg: true }), [true, true, true]);
  assert.deepEqual(await claw({ open: true, forwardAllMsg: true, forwardMediaMsg: true }), [false, false, false]);
  assert.deepEqual(await claw({ open: false, userGroupId: "g", forwardAllMsg: true }), [true, false, false]);
  const b = await mk({ accountName: "别名", robotId: "wxid_bot", recordConfig: { open: true } });
  assert.equal(b.name, "别名"); assert.equal(b.apiSecret, null); assert.equal(b.clawOpen, false); assert.equal(b.avatar, null);
  assert.equal(b.recordOpen, true);  // 开了没选范围也记：范围选了什么都不影响
  assert.equal((await mk({ recordConfig: null })).recordOpen, true);  // 没配过 = 默认记
  assert.equal((await mk({ recordConfig: { open: false, userGroupId: "g" } })).recordOpen, false);  // 明确关掉才算关
  assert.equal((await mk({})).name, "bot7");
  await assert.rejects(mk(null), /读取 bot 7 失败/);
});

test("fetchHistory：映射 type / wxid、单页封顶 500、时间范围从毫秒换成平台要的秒；findAuthorImage 逐页找某人最近一张图", async () => {
  const calls = [];
  const api = { async history(id, q) { calls.push([id, q]); return { rows: [], pagination: null }; } };
  const cfg = { bot: { id: 1 }, history: { defaultCount: 100, quotedImageDepth: 1000 } };
  await fetchHistory(api, cfg, { id: "g@chatroom", isGroup: true }, { pageSize: 999, startTime: 1700000000123, endTime: 1700000099999 });
  assert.deepEqual(calls[0], [1, { type: "room", wxid: "g@chatroom", page: 1, pageSize: 500, startTime: 1700000000, endTime: 1700000099 }]);
  await fetchHistory(api, cfg, { id: "wxid_a", isGroup: false });
  assert.equal(calls[1][1].type, "contact"); assert.equal(calls[1][1].pageSize, 100);
  assert.equal(calls[1][1].startTime, undefined); assert.equal(calls[1][1].endTime, undefined);
  const pages = { 1: [{ chatUserName: "小明", content: "文字" }], 2: [{ chatUserName: "老王", isImage: "True", url: "https://x/w.png" }, { chatUserName: "小明", isImage: "True", url: "https://x/m.png" }] };
  const api2 = { async history(_id, q) { return { rows: pages[q.page] || [], pagination: null }; } };
  assert.equal(await findAuthorImage(api2, cfg, { id: "g@chatroom", isGroup: true }, "小明"), "https://x/m.png");
  assert.equal(await findAuthorImage(api2, cfg, { id: "g@chatroom", isGroup: true }, "没人"), null);
  assert.equal(await findAuthorImage({ async history() { throw new Error("x"); } }, cfg, { id: "g", isGroup: true }, "小明"), null);
});

test("findOssUrl：OSS 地址直接解码返回；uploads 地址去 puppet 日志按文件名尾巴找 remoteUrl；日志接口挂了给 null", async () => {
  const cfg = { bot: { id: 1 } };
  const logText = ["  remoteUrl: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/img/1_/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260922130553.png',", "other line"].join("\n");
  assert.equal(await findOssUrl({ async logs() { return logText; } }, cfg, "https://up/uploads/x/bot_chat_file_微信图片_20260922130553.png", { retries: 0 }), "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/1_/微信图片_20260922130553.png");
  assert.equal(await findOssUrl({ async logs() { return { logs: logText.split("\n") }; } }, cfg, "https://up/uploads/x/微信图片_20260922130553.png", { retries: 0 }), "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/1_/微信图片_20260922130553.png");
  assert.equal(await findOssUrl({ async logs() { return logText; } }, cfg, "https://up/uploads/x/微信图片_20990101000000.png", { retries: 0 }), null);
  assert.equal(await findOssUrl({ async logs() { throw new Error("down"); } }, cfg, "https://up/uploads/x/微信图片_20260922130553.png", { retries: 0 }), null);
  assert.equal(await findOssUrl({ async logs() { throw new Error("不该调") } }, cfg, "https://bucket.oss-cn-hangzhou.aliyuncs.com/a/%E5%9B%BE.png", { retries: 0 }), "https://bucket.oss-cn-hangzhou.aliyuncs.com/a/图.png");
  assert.equal(await findOssUrl({ async logs() { throw new Error("不该调") } }, cfg, "https://up/uploads/x/logo.png", { retries: 0 }), null);  // 没有微信图片尾巴，对不上
});

test("platformSafeText：HTTP 回退时避开平台的整条丢弃词、私聊的 all / @所有人 剔除、群里开头 @所有人；显示不变", () => {
  const ZW = "​";
  assert.equal(platformSafeText("really call me", { isGroup: false }), `rea${ZW}lly ca${ZW}ll me`);
  assert.equal(platformSafeText("really call me", { isGroup: true }), "really call me");  // 群里不掏 all
  assert.equal(platformSafeText("Error: 装不上 TypeError 啊", { isGroup: true }), `Error${ZW}: 装不上 TypeErro${ZW}r 啊`);
  assert.equal(platformSafeText("ReferenceError: x", { isGroup: true }), `ReferenceError${ZW}: x`);  // 长词先处理，不会被 Error: 二次插
  assert.equal(platformSafeText("@所有人 开会", { isGroup: true }), `${ZW}@所有人 开会`);
  assert.equal(platformSafeText("@all 开会", { isGroup: true }), `${ZW}@all 开会`);
  assert.equal(platformSafeText("@所有人 开会", { isGroup: false }), `@${ZW}所有人 开会`);
  assert.equal(platformSafeText("正常的中文回复。", { isGroup: false }), "正常的中文回复。");
  assert.equal(platformSafeText(null, { isGroup: true }), "");
  for (const w of ["OpenAI error", "AxiosError", "FetchError", "TimeoutError", "Run failed:"]) assert.ok(!platformSafeText(`x ${w} y`, { isGroup: true }).includes(w), w);
});

test("isPlatformUrl：在已知主机里、或是平台上传目录的形态才算平台托管；别人的 uploads / 阿里云桶、外站不算；坏 url 不算", () => {
  const hosts = new Set(["platform.example.com", "oss.cdn.example"]);
  assert.equal(isPlatformUrl("https://platform.example.com/anything.png", hosts), true);
  assert.equal(isPlatformUrl("https://oss.cdn.example/img/a.png", hosts), true);
  assert.equal(isPlatformUrl("https://files.example.org/uploads/1/chat/a.png", hosts), true);
  assert.equal(isPlatformUrl("https://files.example.org/uploads/12/bot_avatar_12_123_x.jpeg"), true);
  assert.equal(isPlatformUrl("https://someone.oss-cn-hangzhou.aliyuncs.com/a.png", hosts), false);
  assert.equal(isPlatformUrl("https://blog.example.net/wp-content/uploads/2026/09/a.png", hosts), false);
  assert.equal(isPlatformUrl("https://i.imgur.com/a.png", hosts), false);
  assert.equal(isPlatformUrl("not a url", hosts), false);
});

test("入站：topic 与会话不一致 / 坏 JSON / 缺字段丢弃", () => {
  const rec = JSON.stringify({ conversationId: "g@chatroom", recordType: "room", chatUserId: "u", contentType: "文字", content: "hi" });
  assert.equal(normalizeInbound("chat/1/other@chatroom", rec, 1), null);
  assert.equal(normalizeInbound("chat/1/g@chatroom", "not json", 1), null);
  assert.equal(normalizeInbound("chat/1/g@chatroom", JSON.stringify({ conversationId: "g@chatroom" }), 1), null);
  assert.equal(normalizeInbound("chat/1/g@chatroom", Buffer.from(rec), 1)?.text, "hi"); // Buffer 载荷也行
});

test("时间戳秒 / 毫秒 / 非法", () => {
  assert.equal(toMillis(1700000000), 1700000000000);
  assert.equal(toMillis(1700000000000), 1700000000000);
  assert.ok(Math.abs(toMillis("bad") - Date.now()) < 1000);
  assert.ok(Math.abs(toMillis(undefined) - Date.now()) < 1000);
});
test("图片消息判定：isImage 或扩展名", () => {
  assert.equal(isImageMsg({ url: "https://x/a.JPG" }), true);
  assert.equal(isImageMsg({ url: "https://x/a.png?x=1" }), true);
  assert.equal(isImageMsg({ url: "https://x/a", isImage: "True" }), true);
  assert.equal(isImageMsg({ url: "https://x/a.pdf" }), false);
  assert.equal(isImageMsg({ isImage: true }), false);
  assert.equal(isImageMsg(null), false);
});

test("OpenClaw payload", () => {
  const msgs = [{ type: 1, content: "hi" }];
  assert.deepEqual(openclawOutbound({ id: "g@chatroom", isGroup: true }, msgs, ["wxid_a"]), { isGroup: true, groupId: "g@chatroom", mentionIds: ["wxid_a"], messages: msgs });
  assert.deepEqual(openclawOutbound({ id: "g@chatroom", isGroup: true }, msgs), { isGroup: true, groupId: "g@chatroom", messages: msgs });
  assert.deepEqual(openclawOutbound({ id: "wxid_a", isGroup: false }, msgs, ["x"]), { isGroup: false, contactId: "wxid_a", messages: msgs });
});

test("图片类型按魔数嗅探", () => {
  const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);
  assert.equal(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47])), "image/png");
  assert.equal(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(pad([0x47, 0x49, 0x46, 0x38])), "image/gif");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)])), "image/webp");
  assert.equal(sniffImageType(pad([0x42, 0x4d])), "image/bmp");
  assert.equal(sniffImageType(Buffer.from("hello world!!")), null);
  assert.equal(sniffImageType(Buffer.alloc(3)), null);
});

// ---- 网络函数：mock 全局 fetch ----
const withFetch = async (impl, fn) => {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
};
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
const resp = (status, body, headers = {}) => new Response(body, { status, headers });

test("retry：瞬时错误重试到上限、fatal 立即放弃、delay 按第几次给", async () => {
  const delays = [];
  const withDelay = { retries: 2, delay: (n) => { delays.push(n); return 0; } };
  let calls = 0;
  assert.equal(await retry(async () => (++calls < 3 ? Promise.reject(new Error("x")) : "ok"), withDelay), "ok");
  assert.deepEqual(delays, [1, 2]);
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error("x"); }, withDelay), /x/);
  assert.equal(calls, 3);  // 首次 + 2 次重试
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw fatal("no"); }, withDelay), /no/);
  assert.equal(calls, 1);
  const seen = [];  // onRetry：重试了但最后成功也要留痕，且回调自己抛错不影响重试
  calls = 0;
  assert.equal(await retry(async () => (++calls < 3 ? Promise.reject(new Error("抖")) : "ok"), { ...withDelay, onRetry: (e, n) => { seen.push([e.message, n]); throw new Error("回调炸了"); } }), "ok");
  assert.deepEqual(seen, [["抖", 1], ["抖", 2]]);
});

test("checkStickers：404 / 超时 / 非图片算失效，正常的不报；只看响应头", async () => {
  const list = [{ name: "好的", url: "https://x/a.png" }, { name: "没了", url: "https://x/b.png" }, { name: "网页", url: "https://x/c" }, { name: "慢", url: "https://x/d.png" }];
  const dead = await withFetch(async (url) => {
    if (url.endsWith("a.png")) return resp(200, png, { "content-type": "image/png" });
    if (url.endsWith("b.png")) return resp(404, "");
    if (url.endsWith("/c")) return resp(200, "<html>", { "content-type": "text/html" });
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  }, () => checkStickers(list, { timeoutMs: 1000, allowPrivate: true }));
  assert.deepEqual(dead.sort((a, b) => a.name.localeCompare(b.name)), [{ name: "慢", reason: "超时" }, { name: "没了", reason: "HTTP 404" }, { name: "网页", reason: "不是图片" }].sort((a, b) => a.name.localeCompare(b.name)));
});

test("fetchImageData：魔数优先于错误的 content-type；未就绪重试", async () => {
  let calls = 0;
  const d = await withFetch(async () => (++calls === 1 ? resp(404, "") : resp(200, png, { "content-type": "application/octet-stream" })), () => fetchImageData("https://x/a", { ...IMG, retries: 2 }));
  assert.equal(calls, 2);
  assert.equal(d.mediaType, "image/png");
  assert.equal(d.bytes, png.length);
});
test("fetchImageData：过大与非图片不重试", async () => {
  let calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return resp(200, Buffer.alloc(20)); }, () => fetchImageData("https://x/a", { ...IMG, maxBytes: 10 })), /过大/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return resp(200, Buffer.from("not an image at all"), { "content-type": "text/plain" }); }, () => fetchImageData("https://x/a", IMG)), /不是图片/);
  assert.equal(calls, 1);
});

test("fetchBroker：解 base64 mqInfo，wss 地址换成 mqtt 与 1883；缺字段 / 坏 base64 / 非 2xx 报错", async () => {
  const info = (o) => resp(200, JSON.stringify({ data: { mqInfo: Buffer.from(JSON.stringify(o)).toString("base64") } }));
  const b = await withFetch(async (url) => { assert.equal(url, "https://h/api/v1/platformInfo"); return info({ host: "wss://mq.example.com", name: "u", password: "p" }); }, () => fetchBroker("https://h/", { timeoutMs: 1000 }));
  assert.deepEqual(b, { url: "mqtt://mq.example.com:1883", plainUrl: "mqtt://mq.example.com:1883", username: "u", password: "p" });  // 不认得的 broker 不猜 TLS
  const baidu = await withFetch(async () => info({ host: "wss://abc.iot.gz.baidubce.com", name: "u", password: "p" }), () => fetchBroker("https://h", { timeoutMs: 1000 }));
  assert.deepEqual([baidu.url, baidu.plainUrl], ["mqtts://abc.iot.gz.baidubce.com:1884", "mqtt://abc.iot.gz.baidubce.com:1883"]);
  assert.equal((await withFetch(async () => info({ host: "mqtt://mq:1884", name: "u", password: "p" }), () => fetchBroker("https://h", { timeoutMs: 1000 }))).url, "mqtt://mq:1884");
  await assert.rejects(withFetch(async () => info({ host: "wss://mq", name: "u" }), () => fetchBroker("https://h", { timeoutMs: 1000 })), /缺少字段 password/);
  await assert.rejects(withFetch(async () => resp(200, JSON.stringify({ data: { mqInfo: "!!!" } })), () => fetchBroker("https://h", { timeoutMs: 1000 })), /base64/);
  await assert.rejects(withFetch(async () => resp(200, JSON.stringify({ data: {} })), () => fetchBroker("https://h", { timeoutMs: 1000 })), /缺少 data\.mqInfo/);
  await assert.rejects(withFetch(async () => resp(503, "down"), () => fetchBroker("https://h", { timeoutMs: 1000 })), /HTTP 503/);
});

test("fetchImageData：返回原始 buffer 供上传复用", async () => {
  const d = await withFetch(async () => resp(200, png, { "content-type": "image/png" }), () => fetchImageData("https://x/a", IMG));
  assert.ok(Buffer.isBuffer(d.buffer) && d.buffer.equals(png));
});

// ---- 连接循环 ----
const quiet = { info() {}, warn() {}, error() {} };

test("mqttLoop：resolve 失败按退避重试；close 后不再重试且 current() 为 null", async () => {
  let tries = 0;
  const loop = mqttLoop({ label: "t", log: quiet, net: { ...NET, reconnectBaseMs: 5, reconnectMaxMs: 10 }, resolve: async () => { tries++; throw new Error("nope"); } });
  await delay(60);
  assert.equal(loop.current(), null);
  loop.close();
  const snapshot = tries;
  assert.ok(snapshot >= 3, `应多次重试，实际 ${snapshot}`);
  await delay(40);
  assert.equal(tries, snapshot);
});

test("mqttLoop：connect 同步抛错（非法 URL）也走退避重试，循环不退出", async () => {
  let n = 0;
  const loop = mqttLoop({ label: "t", log: quiet, net: { ...NET, reconnectBaseMs: 5, reconnectMaxMs: 10 }, resolve: async () => { n++; return { url: "bogus", options: { clientId: "x" } }; } });
  await delay(60);
  loop.close();
  assert.ok(n >= 3, `应多次重试，实际 ${n}`);
  assert.equal(loop.current(), null);
});

test("matchOssUrl：同一秒的键对上几个不同地址时不瞎挑，返回 null；同一地址出现多次不算歧义", () => {
  const line = (n) => `  remoteUrl: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/img/${n}_/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260922131854.png',`;
  const up = "https://up/uploads/x/微信图片_20260922131854.png";
  assert.equal(matchOssUrl([line(1), line(2)], up), null);
  assert.equal(matchOssUrl([line(1), line(1)], up), "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/1_/微信图片_20260922131854.png");
});

test("tlsUrl：百度 IoT 的明文 1883 换成 mqtts 1884，别的不动", () => {
  assert.equal(tlsUrl("mqtt://abc.iot.gz.baidubce.com:1883"), "mqtts://abc.iot.gz.baidubce.com:1884");
  assert.equal(tlsUrl("mqtt://abc.iot.gz.baidubce.com"), "mqtts://abc.iot.gz.baidubce.com:1884");
  assert.equal(tlsUrl("mqtt://abc.iot.gz.baidubce.com:2883"), "mqtt://abc.iot.gz.baidubce.com:2883");
  assert.equal(tlsUrl("mqtt://mq.example.com:1883"), "mqtt://mq.example.com:1883");
  assert.equal(tlsUrl("mqtts://x.iot.gz.baidubce.com:1884"), "mqtts://x.iot.gz.baidubce.com:1884");
  assert.equal(tlsUrl("bogus"), "bogus");
});

test("isPrivateAddress：回环 / 私网 / 链路本地 / CGNAT / 组播 / IPv6 本地与映射形式都算内网；公网不算", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "64:ff9b::10.0.0.1", "not-an-ip"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:808:808"]) assert.equal(isPrivateAddress(ip), false, ip);
  for (const ip of ["198.18.0.5", "198.19.255.1"]) assert.equal(isPrivateAddress(ip), false, `${ip}：代理 fake-ip 段不能算内网，否则开着代理一张图都下不了`);
});

test("fetchImageData：不拉内网 / 本机地址，跳转到内网也拦（每跳都校验），不支持的协议直接拒；一律不重试", async () => {
  const opts = { timeoutMs: 1000, maxBytes: 5000000, retries: 3 };
  let calls = 0;
  const f = async () => { calls++; return resp(200, png, { "content-type": "image/png" }); };
  for (const u of ["http://127.0.0.1:8080/a.png", "http://[::ffff:127.0.0.1]/a.png", "http://10.0.0.5/a.png", "http://169.254.169.254/latest/meta-data"]) {
    await assert.rejects(withFetch(f, () => fetchImageData(u, opts)), /内网/, u);
  }
  await assert.rejects(withFetch(f, () => fetchImageData("file:///etc/passwd", opts)), /http\(s\)/);
  assert.equal(calls, 0);
  const hops = [];
  await assert.rejects(withFetch(async (u, init) => { hops.push([u, init.redirect]); return resp(302, null, { location: "http://127.0.0.1/x.png" }); }, () => fetchImageData("http://93.184.216.34/a.png", opts)), /内网/);
  assert.deepEqual(hops, [["http://93.184.216.34/a.png", "manual"]]);
  assert.equal((await withFetch(f, () => fetchImageData("http://10.0.0.5/a.png", { ...opts, trustedHosts: ["10.0.0.5"] }))).mediaType, "image/png");  // 自建平台在内网：平台域名放行
});

test("fetchImageData：跟公网跳转、超过上限就停；content-length 超限不读正文；错误页不当图片（哪怕 url 是 .jpg）", async () => {
  const d = await withFetch(async (u) => (u.endsWith("/a") ? resp(301, null, { location: "/b.png" }) : resp(200, png)), () => fetchImageData("https://x/a", IMG));
  assert.equal(d.mediaType, "image/png");
  let n = 0;
  await assert.rejects(withFetch(async () => { n++; return resp(302, null, { location: `/r${n}` }); }, () => fetchImageData("https://x/a", IMG)), /跳转超过/);
  assert.equal(n, 4);  // 首次 + 3 跳，然后放弃、不重试
  await assert.rejects(withFetch(async () => resp(200, png, { "content-length": "99999999" }), () => fetchImageData("https://x/a", IMG)), /过大/);
  await assert.rejects(withFetch(async () => resp(200, "<html>登录</html>", { "content-type": "text/html; charset=utf-8" }), () => fetchImageData("https://x/a.jpg", IMG)), /不是图片（text\/html）/);
  assert.equal((await withFetch(async (u) => (u.endsWith("/a") ? resp(302, null, { location: "/pic.gif" }) : resp(200, Buffer.alloc(20))), () => fetchImageData("https://x/a", IMG))).mediaType, "image/gif");  // 扩展名兜底看跳转后的地址
});

test("VISION_MEDIA_TYPES：模型只看 jpeg / png / gif / webp，bmp 不在内", () => {
  assert.deepEqual([...VISION_MEDIA_TYPES].sort(), ["image/gif", "image/jpeg", "image/png", "image/webp"]);
  assert.equal(VISION_MEDIA_TYPES.has("image/bmp"), false);
});

test("publishError：只有 client disconnecting（肯定没写出去）算失败，连接被关等都算结果未知、别重发", () => {
  assert.equal(publishError(new Error("client disconnecting")).uncertain, undefined);
  assert.equal(publishError(new Error("Connection closed")).uncertain, true);
  assert.equal(publishError(new Error("Keepalive timeout")).uncertain, true);
});

test("mqttLoop：TLS 连续失败几次后试一次明文；明文也连不上说明是网络问题，回到 TLS 继续试，不会永久退到明文", async () => {
  const urls = [];
  const log = { info: (m) => { const u = /连接 (\S+)（/.exec(m)?.[1]; if (u) urls.push(u); }, warn() {}, error() {} };
  const loop = mqttLoop({ label: "t", log, net: { ...NET, reconnectBaseMs: 2, reconnectMaxMs: 4 }, resolve: async () => ({ url: "bogus-tls", fallbackUrl: "bogus-plain", options: { clientId: "x" } }) });
  await delay(150);
  loop.close();
  assert.ok(urls.length >= 8, urls.join(","));
  assert.deepEqual(urls.slice(0, 8), ["bogus-tls", "bogus-tls", "bogus-tls", "bogus-plain", "bogus-tls", "bogus-tls", "bogus-tls", "bogus-plain"]);
});

test("checkStickers：和下载图片同一套地址校验，内网地址直接算失效、不发请求", async () => {
  let calls = 0;
  const dead = await withFetch(async () => { calls++; return resp(200, png, { "content-type": "image/png" }); }, () => checkStickers([{ name: "内网", url: "http://192.168.1.2/a.png" }], { timeoutMs: 1000 }));
  assert.equal(calls, 0);
  assert.equal(dead.length, 1);
  assert.match(dead[0].reason, /内网/);
});

test("normalizeClawInbound：OpenClaw 转发 → id / 会话 / 发送者 / @ 标志 / 图片地址；@ 只认群里的文字（平台把群里媒体一律标成 @）；坏载荷给 null", () => {
  const n = (o) => normalizeClawInbound(JSON.stringify({ messageId: "m1", robotId: "wxid_bot", senderId: "wxid_a", isGroup: true, groupId: "g@chatroom", type: "文字", isGroupMention: true, ...o }));
  assert.deepEqual(n({}), { id: "m1", isGroup: true, convId: "g@chatroom", senderId: "wxid_a", robotId: "wxid_bot", type: "文字", mention: true, url: null });
  assert.equal(n({ type: "图片", url: "https://oss.x/a.png" }).mention, false);
  assert.equal(n({ type: "图片", url: "https://oss.x/a.png" }).url, "https://oss.x/a.png");
  assert.equal(n({ isGroup: false, groupId: undefined }).convId, "wxid_a");
  assert.equal(n({ isGroup: false }).mention, false);
  assert.equal(n({ isGroupMention: false }).mention, false);
  assert.equal(normalizeClawInbound("not json"), null);
  assert.equal(normalizeClawInbound(JSON.stringify({ content: "x" })), null);  // 没有 messageId 对不上原生记录，没用
});

test("platformSafeText：HTTP 通道会把字面的 \\n 换成换行，回退时插零宽空格保住原样", () => {
  const out = platformSafeText("路径 C:\\new\\n 别换行", { isGroup: true });
  assert.ok(!out.includes("\\n"));
  assert.equal(out.replace(/\u200b/g, ""), "路径 C:\\new\\n 别换行");
});

// puppet 日志里一个微信表情的样子（字段照实际格式，内容替换过）
const varint = (n) => { const out = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n); return Buffer.from(out); };
const pb = (...fields) => Buffer.concat(fields.map(([no, v]) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8"); return Buffer.concat([varint((no << 3) | 2), varint(b.length), b]); }));
const storeDesc = pb([1, pb([1, "default"], [2, "坏蛋"])]).toString("base64");
const emojiLine = ({ id = "5915185591568074692", from = "g1@chatroom", talker = "wxid_a", desc = "", attr = "" } = {}) =>
  `2026-09-25 22:26 +08:00: 22:26:49 INFO event------- ${JSON.stringify({ payload: { msg: `<msg><emoji fromusername = "${talker}" tousername = "${from}" type="2" md5="x" len = "19745" productid="com.tencent.xin.emoticon.person.stiker_x" cdnurl = "http://wxapp.tc.qq.com/262/20304/stodownload?m=abc&amp;filekey=def&amp;bizid=1023" width="240" height="240" desc="${desc}" emojiattr="${attr}"></emoji><gameext type="0" content="0"></gameext></msg>`, text: "", id, atWxidList: [], fromWxid: from, msgType: 47, timeStamp: 1790346408, talkerId: talker, listenerId: "wxid_bot" }, type: 0 })}`;

test("parseStickerEvents：从 puppet 日志行解析微信表情；名称取 desc 的 default，没有再看 emojiattr；&amp; 反转义；别的行跳过", () => {
  const lines = [
    "2026-09-25 22:26 +08:00: 22:26:49 INFO Received payload {\"msg_type\":47}",
    emojiLine({ desc: storeDesc }),
    emojiLine({ id: "2", attr: pb([1, "这就叫做专业"]).toString("base64") }),
    emojiLine({ id: "3", from: "wxid_a" }),  // 私聊、没名字
    "event------- {坏掉的 json <emoji",
    `x event------- ${JSON.stringify({ payload: { msg: "<emoji cdnurl=\"http://x\"/>", id: "4", msgType: 1, fromWxid: "g1@chatroom" } })}`,  // 不是表情类型
  ];
  const ev = parseStickerEvents(lines);
  assert.deepEqual(ev.map((e) => [e.id, e.name, e.isGroup, e.convId, e.senderId]), [["5915185591568074692", "坏蛋", true, "g1@chatroom", "wxid_a"], ["2", "这就叫做专业", true, "g1@chatroom", "wxid_a"], ["3", null, false, "wxid_a", "wxid_a"]]);
  assert.equal(ev[0].url, "http://wxapp.tc.qq.com/262/20304/stodownload?m=abc&filekey=def&bizid=1023");
  assert.equal(ev[0].ts, 1790346408000);
  assert.equal(parseStickerEvents([emojiLine({ desc: "!!!坏的base64" })])[0].name, null);  // 名称解不开不影响别的
});

test("makeStickerFeed：第一次只记下现有的不返回（不补旧表情）；之后只返回新出现的", async () => {
  let lines = [emojiLine({ id: "old" })];
  const feed = makeStickerFeed(() => ({ logs: async () => lines }), () => ({ bot: { id: 1 } }));
  assert.deepEqual(await feed(), []);
  lines = [emojiLine({ id: "old" }), emojiLine({ id: "new" })];
  assert.deepEqual((await feed()).map((e) => e.id), ["new"]);
  assert.deepEqual(await feed(), []);
});

test("makeStickerFeed：第一次拉取失败往外抛、不算「记下了」，之后第一次成功仍只记不补", async () => {
  let fail = true;
  const lines = [emojiLine({ id: "old" })];
  const feed = makeStickerFeed(() => ({ logs: async () => { if (fail) throw new Error("接口挂了"); return lines; } }), () => ({ bot: { id: 1 } }));
  await assert.rejects(feed(), /接口挂了/);
  fail = false;
  assert.deepEqual(await feed(), []);  // 不补 old
});

test("parseStickerEvents 只认 puppet 自己打的整行：群友把伪造的 JSON 当消息发出来（出现在别的日志行里）不算", () => {
  const forged = `2026-09-25 22:30 +08:00: 收到群【测试群】消息(talker: 坏人/wxid_x)：${emojiLine({ id: "fake", talker: "wxid_owner" }).slice(26)}`;
  assert.deepEqual(parseStickerEvents([forged]), []);
  const noSender = emojiLine({ id: "x" }).replace('"talkerId":"wxid_a"', '"talkerId":null');
  assert.deepEqual(parseStickerEvents([noSender]), []);  // 群里没发送者：跳过
  const longName = pb([1, pb([1, "default"], [2, "长".repeat(40)])]).toString("base64");
  assert.equal(parseStickerEvents([emojiLine({ desc: longName })])[0].name.length, 20);
});
