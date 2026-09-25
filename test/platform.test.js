import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeInbound, openclawOutbound, fetchBroker, mqttLoop, startOpenClawSender, startMqtt, isOwnRecord, loadBot, fetchHistory, findAuthorImage, platformSafeText, isPlatformUrl, tlsUrl, publishError, normalizeClawInbound } from "../src/platform.js";
import { EventEmitter } from "node:events";
import { withFetch, resp, json, waitFor } from "./helpers.js";
const NET = { sendTimeoutMs: 15000, sendRetries: 2, platformTimeoutMs: 10000, apiTimeoutMs: 30000, mqttKeepalive: 30, mqttConnectTimeoutMs: 15000, reconnectBaseMs: 2000, reconnectMaxMs: 60000 };

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
  assert.equal(mk({ contentType: "文件", content: "https://up/v.mp4", url: "https://up/v.mp4", fileName: "%E5%BE%AE%E4%BF%A1%E8%A7%86%E9%A2%91_1.mp4" }).text, "微信视频_1.mp4");  // 实测视频的文件名是编码过的
  assert.equal(mk({ contentType: "文件", content: "https://up/y.txt", url: "https://up/y.txt", fileName: "100%完成.txt" }).text, "100%完成.txt");  // 不是编码的百分号原样留
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

test("OpenClaw payload", () => {
  const msgs = [{ type: 1, content: "hi" }];
  assert.deepEqual(openclawOutbound({ id: "g@chatroom", isGroup: true }, msgs, ["wxid_a"]), { isGroup: true, groupId: "g@chatroom", mentionIds: ["wxid_a"], messages: msgs });
  assert.deepEqual(openclawOutbound({ id: "g@chatroom", isGroup: true }, msgs), { isGroup: true, groupId: "g@chatroom", messages: msgs });
  assert.deepEqual(openclawOutbound({ id: "wxid_a", isGroup: false }, msgs, ["x"]), { isGroup: false, contactId: "wxid_a", messages: msgs });
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

test("tlsUrl：百度 IoT 的明文 1883 换成 mqtts 1884，别的不动", () => {
  assert.equal(tlsUrl("mqtt://abc.iot.gz.baidubce.com:1883"), "mqtts://abc.iot.gz.baidubce.com:1884");
  assert.equal(tlsUrl("mqtt://abc.iot.gz.baidubce.com"), "mqtts://abc.iot.gz.baidubce.com:1884");
  assert.equal(tlsUrl("mqtt://abc.iot.gz.baidubce.com:2883"), "mqtt://abc.iot.gz.baidubce.com:2883");
  assert.equal(tlsUrl("mqtt://mq.example.com:1883"), "mqtt://mq.example.com:1883");
  assert.equal(tlsUrl("mqtts://x.iot.gz.baidubce.com:1884"), "mqtts://x.iot.gz.baidubce.com:1884");
  assert.equal(tlsUrl("bogus"), "bogus");
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

// ---- 真的 OpenClaw 发送通道（startOpenClawSender），只把 mqtt 客户端换成假的 ----
/** 假 mqtt 客户端：publish 的回调由测试决定何时、怎么调；close() 模拟断线。 */
function fakeMqtt() {
  const clients = [];
  const connect = () => {
    const c = Object.assign(new EventEmitter(), {
      connected: false, published: [],
      publish(topic, body, opts, cb) { c.published.push({ topic, body, cb }); },
      subscribe() {},
      end() { c.drop(); },
      drop() { if (!c.closed) { c.closed = true; c.connected = false; c.emit("close"); } },
    });
    clients.push(c);
    setImmediate(() => { c.connected = true; c.emit("connect"); });
    return c;
  };
  return { clients, connect };
}
const NET_OC = { sendTimeoutMs: 80, platformTimeoutMs: 1000, mqttKeepalive: 30, mqttConnectTimeoutMs: 1000, reconnectBaseMs: 60_000, reconnectMaxMs: 60_000 };
async function openClaw() {
  const m = fakeMqtt();
  const config = { host: "mqtt://x", port: 1883, username: "u", password: "p", clientId: "c", sendTopic: "s" };
  const oc = await withFetch(async () => json(config), async () => {  // 拉 OpenClaw 配置的 fetch 只在连上之前用；waitFor 超时也会换回来
    const oc = startOpenClawSender({ host: "https://h", apiSecret: "k", clientIdSuffix: "-t", log: { info() {}, warn() {}, error() {} }, net: NET_OC, connect: m.connect });
    await waitFor(() => oc.connected());
    return oc;
  });
  return { oc, client: m.clients[0] };
}

test("startOpenClawSender：等 PUBACK 超时、等的时候断线，都拒成「结果未知」（调用方据此不回退 HTTP）；没连上直接报错（不是结果未知，可以回退）", async () => {
  const a = await openClaw();
  await assert.rejects(a.oc.publish({ x: 1 }), (e) => e.uncertain === true && /超时/.test(e.message));  // 回调一直不来
  const p = a.oc.publish({ x: 2 });
  a.client.drop();  // 等 PUBACK 时 broker 断开：mqtt.js 不会回调，要自己拒
  await assert.rejects(p, (e) => e.uncertain === true && /断开/.test(e.message));
  await assert.rejects(a.oc.publish({ x: 3 }), (e) => !e.uncertain && /未连接/.test(e.message));
  a.oc.close();

  const b = await openClaw();
  const ok = b.oc.publish({ y: 1 });
  b.client.published[0].cb();  // PUBACK 到了
  await ok;
  const gone = b.oc.publish({ y: 2 });
  b.client.published[1].cb(new Error("client disconnecting"));  // mqtt.js 明说没写出去：肯定没发，可以回退
  await assert.rejects(gone, (e) => !e.uncertain);
  b.oc.close();
});

test("startMqtt：订阅成功记 info、回调 onSubscribed；自己关连接时订阅被打断不记 error（重启时的假警报），真失败才记", async () => {
  const lines = [];
  const log = { info: (m) => lines.push(["info", m]), warn: (m) => lines.push(["warn", m]), error: (m) => lines.push(["error", m]) };
  const broker = () => resp(200, JSON.stringify({ data: { mqInfo: Buffer.from(JSON.stringify({ host: "mqtt://mq:1883", name: "u", password: "p" })).toString("base64") } }));
  const run = (subscribe) => withFetch(async () => broker(), async () => {
    const m = fakeMqtt();
    let calls = 0, subscribed = 0;
    const loop = startMqtt({
      host: "https://h", botId: 1, clientId: "c", onMessage() {}, onSubscribed: () => subscribed++, log, net: NET_OC,
      connect: (...a) => Object.assign(m.connect(...a), { subscribe(...args) { calls++; return subscribe.apply(this, args); } }),
    });
    try { await waitFor(() => calls === 1); } finally { loop.close(); }  // 订阅失败时同一拍里就断开了，等「连上」等不到；不关的话退避定时器会挂住进程
    return subscribed;
  });
  assert.equal(await run(function (_t, _o, cb) { cb(null); }), 1);
  assert.ok(lines.some(([lv, m]) => lv === "info" && m === "已订阅 chat/1/+"));
  lines.length = 0;
  await run(function (_t, _o, cb) { this.disconnecting = true; cb(new Error("Connection closed")); });
  assert.ok(!lines.some(([lv]) => lv === "error"));
  await run(function (_t, _o, cb) { cb(new Error("Not authorized")); });
  assert.ok(lines.some(([lv, m]) => lv === "error" && /订阅失败：Not authorized/.test(m)));
});
