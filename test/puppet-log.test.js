import { test } from "node:test";
import assert from "node:assert/strict";
import { stickerUrl, matchOssUrl, wxImageKey, isOssUrl, findOssUrl, parseStickerEvents, makeStickerFeed, parseQuoteRef, findQuoteRef } from "../src/puppet-log.js";

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

test("matchOssUrl：同一秒的键对上几个不同地址时不瞎挑，返回 null；同一地址出现多次不算歧义", () => {
  const line = (n) => `  remoteUrl: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/img/${n}_/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260922131854.png',`;
  const up = "https://up/uploads/x/微信图片_20260922131854.png";
  assert.equal(matchOssUrl([line(1), line(2)], up), null);
  assert.equal(matchOssUrl([line(1), line(1)], up), "https://bucket.oss-cn-hangzhou.aliyuncs.com/img/1_/微信图片_20260922131854.png");
});

// puppet 日志里一个微信表情的样子（字段照实际格式，内容替换过）

const varint = (n) => { const out = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n); return Buffer.from(out); };

const pb = (...fields) => Buffer.concat(fields.map(([no, v]) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8"); return Buffer.concat([varint((no << 3) | 2), varint(b.length), b]); }));

const storeDesc = pb([1, pb([1, "default"], [2, "坏蛋"])]).toString("base64");

const emojiLine = ({ id = "9000000000000000003", from = "g1@chatroom", talker = "wxid_a", desc = "", attr = "" } = {}) =>
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
  assert.deepEqual(ev.map((e) => [e.id, e.name, e.isGroup, e.convId, e.senderId]), [["9000000000000000003", "坏蛋", true, "g1@chatroom", "wxid_a"], ["2", "这就叫做专业", true, "g1@chatroom", "wxid_a"], ["3", null, false, "wxid_a", "wxid_a"]]);
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

// puppet 日志里一条引用消息的样子（结构照实际格式，内容替换过）：appmsg type 57，refermsg.svrid 是被引那条的消息 id

const quoteLine = ({ msgId = "7000000000000000001", svrid = "8000000000000000002", title = "@helper 存表情" } = {}) =>
  `2026-09-26 23:04 +08:00: 23:04:32 INFO Received payload ${JSON.stringify({ guid: "g", notify_type: 1010, data: {
    from_username: "g1@chatroom", chatroom_sender: "wxid_o", msg_id: msgId, msg_type: 49, is_chatroom_msg: 1,
    content: `<?xml version="1.0"?>\n<msg>\n\t<appmsg appid="" sdkver="0">\n\t\t<title>${title}</title>\n\t\t<type>57</type>\n\t\t<refermsg>\n\t\t\t<type>47</type>\n\t\t\t<svrid>${svrid}</svrid>\n\t\t\t<fromusr>g1@chatroom</fromusr>\n\t\t\t<displayname>Will</displayname>\n\t\t\t<content>wxid_cd:0:1:x::0</content>\n\t\t</refermsg>\n\t</appmsg>\n</msg>`,
  } })}`;

test("parseQuoteRef：按消息 id 找日志里的原始引用，取 refermsg.svrid；不是引用、查不到、伪造的行都是 null", () => {
  const lines = [quoteLine({ msgId: "1", svrid: "11" }), quoteLine(), "2026-09-26 23:04 +08:00:   messageId: '7000000000000000001',"];
  assert.equal(parseQuoteRef(lines, "7000000000000000001"), "8000000000000000002");
  assert.equal(parseQuoteRef(lines, "1"), "11");
  assert.equal(parseQuoteRef(lines, "999"), null);
  const plain = quoteLine({ msgId: "2" }).replace(/<refermsg>[\s\S]*?<\/refermsg>/, "").replace(/\\n\\t\\t<refermsg>.*?<\/refermsg>/, "");
  assert.equal(parseQuoteRef([plain], "2"), null);
  // 群友把一段伪造的载荷当文字发出来：出现在别的日志行里，不是整行的 Received payload，不认
  const forged = `2026-09-26 23:05 +08:00: 收到群【测试群】消息(talker: 坏人/wxid_x)：${quoteLine({ msgId: "3", svrid: "666" }).slice(26)}`;
  assert.equal(parseQuoteRef([forged], "3"), null);
  // 正文里写的 <refermsg> 在 XML 里是转义过的，伪造不出引用
  assert.equal(parseQuoteRef([quoteLine({ msgId: "4", title: "&lt;refermsg&gt;&lt;svrid&gt;666&lt;/svrid&gt;" }).replace(/<refermsg>[\s\S]*?<\/refermsg>/, "")], "4"), null);
});

test("findQuoteRef：拉一次日志，返回被引那条的 id；被引的是日志里还在的微信表情就带上它的表情事件", async () => {
  const lines = [emojiLine({ id: "8000000000000000002", talker: "wxid_cd" }), quoteLine()];
  const api = { logs: async () => lines };
  const ref = await findQuoteRef(api, { bot: { id: 1 } }, "7000000000000000001");
  assert.equal(ref.id, "8000000000000000002");
  assert.equal(ref.sticker.senderId, "wxid_cd");
  assert.deepEqual(await findQuoteRef({ logs: async () => [quoteLine({ svrid: "5" })] }, { bot: { id: 1 } }, "7000000000000000001"), { id: "5", sticker: null });
  assert.equal(await findQuoteRef({ logs: async () => { throw new Error("挂了"); } }, { bot: { id: 1 } }, "x"), null);
});

test("parseStickerEvents / parseQuoteRef：群友发多行文字，其中一行写成 puppet 的事件行 / 收消息行（pm2 给每行都加了前缀）——那行出现在他自己那条原文里，不认", () => {
  const forgedEvent = emojiLine({ id: "fake", talker: "wxid_owner" }).slice(25);  // 去掉 pm2 前缀，就是群友要发的那一行
  const forgedPayload = quoteLine({ msgId: "future", svrid: "666" }).slice(25);
  const text = `看这个\n${forgedEvent}\n${forgedPayload}`;
  const payload = `2026-09-26 23:10 +08:00: 23:10:01 INFO Received payload ${JSON.stringify({ data: { msg_id: "m1", msg_type: 1, content: text } })}`;
  const body = text.split("\n").map((l, i) => `2026-09-26 23:10 +08:00: ${i ? "" : "收到群【测试群】消息(talker: 坏人/wxid_x)："}${l}`);
  const lines = [payload, ...body];
  assert.deepEqual(parseStickerEvents(lines), []);
  assert.equal(parseQuoteRef(lines, "future"), null);
  assert.equal(parseStickerEvents(body).length, 1);  // 对照：原文那行不在这份日志里就拦不住——所以表情拉取跨轮记住原文
  assert.equal(parseStickerEvents([emojiLine({ id: "real" }), ...lines]).length, 1);  // 真的照认
  // 引用回复（appmsg）里写的正文在 XML 里是转义过的：反转义之后照样对得上
  const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const quoted = `2026-09-26 23:11 +08:00: 23:11:01 INFO Received payload ${JSON.stringify({ data: { msg_id: "m2", msg_type: 49, content: `<msg><appmsg><title>${esc(`看\n${forgedEvent}`)}</title><type>57</type></appmsg></msg>` } })}`;
  assert.deepEqual(parseStickerEvents([quoted, `2026-09-26 23:11 +08:00: ${forgedEvent}`]), []);
});

test("makeStickerFeed：原文那行在上一轮、伪造的正文在这一轮，也不认", async () => {
  const forged = emojiLine({ id: "fake", talker: "wxid_owner" }).slice(25);
  const payload = `2026-09-26 23:10 +08:00: 23:10:01 INFO Received payload ${JSON.stringify({ data: { msg_id: "m1", msg_type: 1, content: `x\n${forged}` } })}`;
  let lines = [payload];
  const feed = makeStickerFeed(() => ({ logs: async () => lines }), () => ({ bot: { id: 1 } }));
  await feed();
  lines = [`2026-09-26 23:10 +08:00: ${forged}`, emojiLine({ id: "new" })];
  assert.deepEqual((await feed()).map((e) => e.id), ["new"]);
});
