// harness 端到端：平台 IO、模型、日志全部注入假实现，从入站消息一路跑到出站队列，验证编排层本身。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHarness } from "../src/harness.js";
import { fetchHistory } from "../src/platform.js";
import { DEFAULTS, merge } from "../src/config.js";

const ROOM = "g1@chatroom", OWNER = "wxid_owner", BOT_WXID = "wxid_bot";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error("等待超时"); await sleep(10); }
};

/** 起一个全假 IO 的 harness：入站靠 h.inbound 注入，HTTP 出站落在 sent、上传落在 uploads，模型回复由 respond 决定；account 覆盖平台返回的机器人行。 */
async function boot({ respond, config = {}, deps = {}, account = {}, statusFn = null, dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-")) } = {}) {
  const cfgFile = path.join(dir, "config.jsonc");
  fs.writeFileSync(cfgFile, JSON.stringify({
    host: "https://h", token: "tok", workspace: "ws", bot: { id: 1 }, owner: OWNER,
    groups: { allow: [ROOM], warmupHistory: 0 },
    agent: { baseUrl: "https://llm", token: "k", model: "m", debounceMs: 0 },
    images: { vision: false },
    limits: { minIntervalMs: 1, quietHours: { enabled: false } },
    ...config,
  }));
  const sent = [], uploads = [], events = [], agentCalls = [], lines = [];  // lines：info / warn / error 的文本，断言启动告警用
  const injected = [];  // 经 h.inbound 注入的消息：假平台历史就是它们（主人身份核对要查历史）；forged 标记的不进历史，模拟伪造的推送
  const api = {
    bot: async () => ({ id: "hashed", name: "helper", robotId: BOT_WXID, apiSecret: null, clawConfig: { open: false }, recordConfig: { open: true, userGroupId: "g" }, ...account }),
    status: async () => (statusFn ? statusFn() : {}),
    logs: async () => "",
    history: async (_id, q) => ({
      rows: injected.filter((m) => m.conv.id === q.wxid && !m.forged).map((m) => ({ msgId: m.id, chatUserId: m.sender.id, chatUserName: m.sender.name, timestamp: m.ts, content: m.historyText ?? m.text })).reverse(),
      pagination: null,
    }),
    send: async (_id, target, messages) => { sent.push({ target, messages }); },
    upload: async ({ filename, mediaType }) => { uploads.push({ filename, mediaType }); return `https://h/uploads/1/chat/${filename}`; },
  };
  const h = await runHarness({
    root: dir, configFile: cfgFile, hot: false,
    deps: {
      // 假日志器：with() 和真的一样把固定字段并进事件，测试才看得到 turn / conv；info 级也记下来
      makeLog: () => {
        const scope = (fields) => ({
          info: (m, e) => lines.push({ level: "info", msg: m, ...fields, ...e }),
          warn: (m, e) => lines.push({ level: "warn", msg: m, ...fields, ...e }),
          error: (m, e) => lines.push({ level: "error", msg: m, ...fields, ...e }),
          event: (name, data = {}) => events.push({ ev: name, ...fields, ...data }),
          with: (extra = {}) => scope({ ...fields, ...extra }),
        });
        return scope({});
      },
      makeApi: () => api,
      startMqtt: () => ({ close() {}, current: () => null }),
      makeStickerFeed: () => async () => [],  // 默认不拉 puppet 日志；测微信表情的用例自己换
      startOpenClawSender: () => ({ connected: () => false, publish: async () => {}, close() {} }),
      checkStickers: async () => [],
      fetchImageData: async () => ({ mediaType: "image/png", base64: "AAAA", buffer: Buffer.from("png") }),
      makeAgent: () => ({ run: async (args) => { agentCalls.push(args); return respond ? respond(args) : { text: "NO_REPLY", reason: "end_turn" }; } }),
      ...deps,
    },
  });
  const inbound = h.inbound;
  h.inbound = (m) => { injected.push(m); return inbound(m); };
  return { h, dir, sent, uploads, events, agentCalls, lines, close: () => h.close() };
}

let seq = 0;
/** 造一条 normalizeInbound 形状的入站消息；conv 传群 id 或私聊 wxid。 */
const msg = ({ conv = ROOM, sender = {}, ...rest } = {}) => {
  const ts = Date.now();
  const isGroup = conv.endsWith("@chatroom");
  const s = { id: "wxid_a", name: "小明", ...sender };
  return {
    id: `m${++seq}`, ts, receivedAt: ts, type: "文字", text: "", url: null, isImage: false, robotId: BOT_WXID, isMine: false,
    sender: s, isGroup, mention: false, conv: { id: conv, name: isGroup ? "测试群" : s.name, isGroup },
    ...rest,
  };
};
const runToolByName = (args, name, input) => args.tools.find((t) => t.name === name).run(input);
const readCtx = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, "ws", "context", `${id}.json`), "utf8"));

test("群里 @ 触发：未触发的先进上下文；模型看到去掉 @ 的触发文本；回复补 @ 回触发者、HTTP 回退拼进正文；自己的回复记进上下文", async () => {
  const { h, dir, sent, agentCalls, events, close } = await boot({ respond: () => ({ text: "在的", reason: "end_turn", usage: { input: 1, output: 1 } }) });
  h.inbound(msg({ text: "先聊点别的", sender: { id: "wxid_b", name: "老王" } }));
  h.inbound(msg({ text: "@helper 在吗" }));
  await waitFor(() => sent.length === 1);
  assert.equal(agentCalls.length, 1);
  assert.match(agentCalls[0].userText, /老王 \(wxid_b\): 先聊点别的/);
  assert.match(agentCalls[0].userText, /<trigger>[\s\S]*小明 \(wxid_a\): 在吗\n<\/trigger>/);
  assert.deepEqual(sent[0].target, { id: ROOM, type: "room" });
  assert.deepEqual(sent[0].messages, [{ type: 1, content: "@小明 在的" }]);  // 窗口内两人在聊 → 补 @；没 OpenClaw → 拼进正文
  assert.deepEqual(events.filter((e) => e.ev === "inbound").map((e) => e.verdict), ["context", "trigger"]);
  assert.equal(events.find((e) => e.ev === "outbound").parts, 1);
  await close();
  const ctx = readCtx(dir, ROOM);
  assert.equal(ctx.length, 3);
  assert.equal(ctx.at(-1).mine, true);
  assert.equal(ctx.at(-1).text, "@小明 在的");  // 记实际显示形态
});

test("门控：非白名单群、自己的回显不触发也不进上下文；机器人改名从回显学到，新名立刻能 @ 到", async () => {
  const { h, dir, agentCalls, events, close } = await boot({ respond: () => ({ text: "NO_REPLY", reason: "end_turn" }) });
  h.inbound(msg({ conv: "other@chatroom", text: "@helper 在吗" }));
  h.inbound(msg({ text: "@helper 我是回显", isMine: true, sender: { id: BOT_WXID, name: "helper" } }));
  await sleep(30);
  assert.equal(agentCalls.length, 0);
  assert.deepEqual(events.filter((e) => e.ev === "inbound").map((e) => e.reason), ["group-not-allowed", "self"]);
  h.inbound(msg({ text: "我改名了", isMine: true, sender: { id: BOT_WXID, name: "小助手" } }));
  h.inbound(msg({ text: "@小助手 在吗" }));
  await waitFor(() => agentCalls.length === 1);
  assert.match(agentCalls[0].system, /你的微信昵称是「小助手」/);
  await close();
  assert.ok(!fs.existsSync(path.join(dir, "ws", "context", "other@chatroom.json")));
});

test("bot.name 钉住昵称：平台记的旧名 @ 不到、回显不覆盖；热更新清空后回到平台的", async () => {
  const { h, dir, agentCalls, events, close } = await boot({ config: { bot: { id: 1, name: "小狗" } } });
  h.inbound(msg({ text: "@helper 在吗" }));  // 平台那份还是登录时的旧名
  h.inbound(msg({ text: "我是回显", isMine: true, sender: { id: BOT_WXID, name: "helper" } }));
  h.inbound(msg({ text: "@小狗 在吗" }));
  await waitFor(() => agentCalls.length === 1);
  assert.match(agentCalls[0].system, /你的微信昵称是「小狗」/);
  assert.deepEqual(events.filter((e) => e.ev === "inbound").map((e) => e.reason), ["not-triggered", "self", "at-text"]);
  const cfgFile = path.join(dir, "config.jsonc");
  fs.writeFileSync(cfgFile, JSON.stringify(merge(JSON.parse(fs.readFileSync(cfgFile, "utf8")), { bot: { name: "" } })));
  await h.reload();
  h.inbound(msg({ text: "@helper 在吗" }));
  await waitFor(() => agentCalls.length === 2);
  assert.match(agentCalls[1].system, /你的微信昵称是「helper」/);
  await close();
});

test("私聊：主动 NO_REPLY 不发；拒答 / 出错发 dm.fallback（工具已经发过东西就不补）；群里拒答沉默；fallback 留空则私聊也沉默", async () => {
  let mode = "noreply";
  const respond = async () => {
    if (mode === "noreply") return { text: "**NO_REPLY**", reason: "end_turn" };
    if (mode === "refusal") return { text: null, reason: "refusal", category: "cyber" };
    throw new Error("网络炸了");
  };
  const owner = { conv: OWNER, sender: { id: OWNER, name: "主人" } };
  const { h, sent, events, close } = await boot({ respond });
  const agentEvents = () => events.filter((e) => e.ev === "agent");
  h.inbound(msg({ ...owner, text: "在吗" }));
  await waitFor(() => agentEvents().length === 1);
  await sleep(30);
  assert.equal(sent.length, 0);
  assert.equal(agentEvents()[0].noReply, true);
  mode = "refusal";
  h.inbound(msg({ ...owner, text: "帮我干点坏事" }));
  await waitFor(() => sent.length === 1);
  assert.deepEqual(sent[0], { target: { id: OWNER, type: "contact" }, messages: [{ type: 1, content: DEFAULTS.dm.fallback }] });
  assert.equal(agentEvents()[1].failed, true);
  mode = "error";
  h.inbound(msg({ ...owner, text: "再试" }));
  await waitFor(() => sent.length === 2);
  assert.equal(agentEvents()[2].reason, "error");
  mode = "refusal";
  h.inbound(msg({ text: "@helper 干坏事" }));  // 群里
  await waitFor(() => agentEvents().length === 4);
  await sleep(30);
  assert.equal(sent.length, 2);
  await close();

  // 这一轮已经用工具发过东西（表情、say）再出错：不补「没接上」，发完表情再来一句兜底反而怪
  const partial = await boot({ respond: async ({ tools }) => { await tools.find((t) => t.name === "say").run({ text: "我看看" }); throw new Error("网络炸了"); } });
  partial.h.inbound(msg({ ...owner, text: "查一下" }));
  await waitFor(() => partial.events.some((e) => e.ev === "agent"));
  await sleep(30);
  assert.deepEqual(partial.sent.map((x) => x.messages[0].content), ["我看看"]);
  await partial.close();

  const quiet = await boot({ respond, config: { dm: { fallback: "" } } });
  quiet.h.inbound(msg({ ...owner, text: "在吗" }));
  await waitFor(() => quiet.events.some((e) => e.ev === "agent"));
  await sleep(30);
  assert.equal(quiet.sent.length, 0);
  await quiet.close();
});

test("工具发图：出站 type 10、群里第二张被拒改文字、自己发的图记进上下文让下一轮看见", async () => {
  let round = 0;
  const respond = async ({ tools }) => {
    if (++round > 1) return { text: "NO_REPLY", reason: "end_turn" };
    const tool = tools.find((t) => t.name === "send_image");
    await tool.run({ url: "https://x/a.png" });
    let second = "ok";
    try { await tool.run({ url: "https://x/b.png" }); } catch (e) { second = e.message; }
    return { text: `第二张：${second}`, reason: "end_turn" };
  };
  const { h, sent, agentCalls, events, close } = await boot({ respond });
  h.inbound(msg({ text: "@helper 发张图" }));
  await waitFor(() => sent.length === 2);
  assert.deepEqual(sent[0].messages, [{ type: 10, url: "https://x/a.png" }]);
  assert.match(sent[1].messages[0].content, /^第二张：这一轮已经发过 1 张图 \/ 表情，群里一次回复最多 1 张/);  // 只有他一人在聊，不补 @
  assert.equal(events.find((e) => e.ev === "agent").toolSends, 1);
  h.inbound(msg({ text: "@helper 你刚发了啥" }));
  await waitFor(() => agentCalls.length === 2);
  assert.match(agentCalls[1].userText, /helper（我）: \[图片\]\n/);
  await close();
});

test("群里明说要多发（引用机器人的清单说「都发出来」）：这一轮放宽到 groupImagesOnRequest，system 里照实告诉模型；没说就还是平时的上限", async () => {
  const errs = [];
  const respond = async (args) => {
    for (const url of ["https://x/1.png", "https://x/2.png", "https://x/3.png"]) {
      try { await runToolByName(args, "send_image", { url }); } catch (e) { errs.push(e.message); }
    }
    return { text: "NO_REPLY", reason: "end_turn" };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
  fs.mkdirSync(path.join(dir, "ws"));
  fs.writeFileSync(path.join(dir, "ws", "stickers.json"), JSON.stringify([{ name: "A", url: "https://x/a.png" }]));  // 有图库才有表情包那段 system
  const { h, sent, agentCalls, events, close } = await boot({ dir, respond, config: { limits: { minIntervalMs: 1, quietHours: { enabled: false }, groupImagesOnRequest: 2 } } });
  h.inbound(msg({ text: "「helper：\n我有这三张：1. A 2. B 3. C」\n- - - - - - - - - - - - - - -\n都发出来看看" }));
  await waitFor(() => agentCalls.length === 1 && sent.length === 2);
  assert.deepEqual(sent.map((x) => x.messages[0].url), ["https://x/1.png", "https://x/2.png"]);
  assert.match(errs[0], /群里一次回复最多 2 张/);
  assert.match(agentCalls[0].system, /这一轮有人明说要多发，最多 2 张/);
  assert.equal(events.find((e) => e.ev === "agent").imageCap, 2);
  h.inbound(msg({ text: "@helper 发张图" }));  // 没说要多发：还是 1 张
  await waitFor(() => agentCalls.length === 2 && errs.length === 3);
  assert.equal(sent.length, 3);
  assert.match(agentCalls[1].system, /群里一轮最多 1 张/);
  assert.equal(events.filter((e) => e.ev === "agent")[1].imageCap, undefined);
  await close();
});

test("看图：触发点附近的图下载成 base64 传给模型；窗口外不自动带；引用「某人：图片」精准找回", async () => {
  const { h, agentCalls, close } = await boot({ config: { images: { vision: true, window: 2 } } });
  h.inbound(msg({ type: "文件", url: "https://x/pic.png", isImage: true, sender: { id: "wxid_b", name: "老王" } }));
  h.inbound(msg({ text: "@helper 这图啥意思" }));
  await waitFor(() => agentCalls.length === 1);
  assert.deepEqual(agentCalls[0].images, [{ mediaType: "image/png", base64: "AAAA" }]);
  h.inbound(msg({ text: "灌水 1", sender: { id: "wxid_c", name: "路人" } }));
  h.inbound(msg({ text: "灌水 2", sender: { id: "wxid_c", name: "路人" } }));
  h.inbound(msg({ text: "@helper 再看看" }));
  await waitFor(() => agentCalls.length === 2);
  assert.deepEqual(agentCalls[1].images, []);
  h.inbound(msg({ text: "「老王：图片」\n- - -\n@helper 这张呢" }));
  await waitFor(() => agentCalls.length === 3);
  assert.equal(agentCalls[2].images.length, 1);
  await close();
});

test("文字优先走 OpenClaw（群和私聊）、正文不带 @ 只传 mentionIds、记进发送日志；OpenClaw 失败回退 HTTP 且避开平台文本过滤；投递路径落成 sent 事件", async () => {
  const published = [];
  let fail = false;
  const { h, dir, sent, events, close } = await boot({
    respond: () => ({ text: "really Error: 在的", reason: "end_turn" }),
    account: { apiSecret: "s", clawConfig: { open: true } },
    deps: { startOpenClawSender: () => ({ connected: () => true, publish: async (p) => { if (fail) throw new Error("断了"); published.push(p); }, close() {} }) },
  });
  h.inbound(msg({ text: "先聊点别的", sender: { id: "wxid_b", name: "老王" } }));
  h.inbound(msg({ text: "@helper 在吗" }));
  await waitFor(() => published.length === 1);
  await waitFor(() => events.some((e) => e.ev === "sent"));
  const first = events.find((e) => e.ev === "sent");
  assert.equal(first.channel, "openclaw");            // 日志能证明这轮真的从哪条通道发出去的
  assert.equal(first.kind, "文字");
  assert.equal(first.count, 1);
  assert.equal(first.conv, ROOM);                // 子日志器把 conv / turn 带进来了
  assert.ok(first.turn);
  assert.ok(first.elapsedMs >= 0);
  assert.deepEqual(published[0], { isGroup: true, groupId: ROOM, mentionIds: ["wxid_a"], messages: [{ type: 1, content: "really Error: 在的" }] });
  const owner = { conv: OWNER, sender: { id: OWNER, name: "主人" } };
  h.inbound(msg({ ...owner, text: "在吗" }));
  await waitFor(() => published.length === 2);
  assert.deepEqual(published[1], { isGroup: false, contactId: OWNER, messages: [{ type: 1, content: "really Error: 在的" }] });  // 私聊也走 OpenClaw，原文不动
  assert.equal(sent.length, 0);
  fail = true;
  h.inbound(msg({ ...owner, text: "再说一遍" }));
  await waitFor(() => sent.length === 1);
  assert.equal(events.filter((e) => e.ev === "sent").at(-1).channel, "http");  // 回退 HTTP 也记明走了哪条路
  assert.equal(events.filter((e) => e.ev === "sent").at(-1).kind, "文字");
  assert.deepEqual(sent[0], { target: { id: OWNER, type: "contact" }, messages: [{ type: 1, content: "rea​lly Error​: 在的" }] });  // 回退 HTTP：塞零宽空格避开平台丢弃 / 掏空
  await close();
  const readLog = (id) => fs.readFileSync(path.join(dir, "ws", "sent", `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
  assert.deepEqual(readLog(ROOM), ["@小明 really Error: 在的"]);  // 记的是显示形态
  assert.deepEqual(readLog(OWNER), ["really Error: 在的"]);  // 回退 HTTP 的那条平台自己会记，不进发送日志
});

test("发图：外站图片先上传到平台托管再发，平台自己的图原样发；没 apiSecret 不搬", async () => {
  const respond = async ({ tools }) => {
    const t = tools.find((x) => x.name === "send_image");
    await t.run({ url: "https://example.com/pic.png" });
    await t.run({ url: "https://h/uploads/1/chat/y.png" });
    return { text: "NO_REPLY", reason: "end_turn" };
  };
  const owner = { conv: OWNER, sender: { id: OWNER, name: "主人" } };
  const a = await boot({ respond, account: { apiSecret: "s" } });
  a.h.inbound(msg({ ...owner, text: "发图" }));
  await waitFor(() => a.sent.length === 2);
  assert.equal(a.uploads.length, 1);
  assert.equal(a.uploads[0].mediaType, "image/png");
  assert.match(a.sent[0].messages[0].url, /^https:\/\/h\/uploads\/1\/chat\/harness_\d+\.png$/);
  assert.equal(a.sent[1].messages[0].url, "https://h/uploads/1/chat/y.png");
  await a.close();
  const b = await boot({ respond });
  b.h.inbound(msg({ ...owner, text: "发图" }));
  await waitFor(() => b.sent.length === 2);
  assert.equal(b.uploads.length, 0);
  assert.equal(b.sent[0].messages[0].url, "https://example.com/pic.png");
  await b.close();
});

test("头像：提到头像就把头像图附在最后并说明；没本地文件用平台的；send_avatar 平台头像直接发、本地文件上传一次并缓存；save_avatar 存主人的图", async () => {
  let action = "ask";
  const respond = async ({ tools }) => {
    if (action === "send") { await tools.find((t) => t.name === "send_avatar").run({}); return { text: "NO_REPLY", reason: "end_turn" }; }
    if (action === "save") { await tools.find((t) => t.name === "save_avatar").run({}); return { text: "存好了", reason: "end_turn" }; }
    return { text: "NO_REPLY", reason: "end_turn" };  // 问头像那几轮不发文字，免得干扰对 sent 的计数
  };
  const owner = { conv: OWNER, sender: { id: OWNER, name: "主人" } };
  const { h, dir, sent, uploads, agentCalls, close } = await boot({ respond, config: { images: { vision: true } }, account: { apiSecret: "s", avatar: "/uploads/1/bot_avatar.jpeg" } });
  h.inbound(msg({ ...owner, text: "你头像是啥" }));
  await waitFor(() => agentCalls.length === 1);
  assert.deepEqual(agentCalls[0].images, [{ mediaType: "image/png", base64: "AAAA" }]);  // 没本地文件 → 拉平台头像（假下载给 png）附上
  assert.match(agentCalls[0].userText, /附图说明：最后一张图是你自己当前的微信头像/);
  assert.match(agentCalls[0].system, /你有微信头像/);
  h.inbound(msg({ ...owner, text: "在吗" }));
  await waitFor(() => agentCalls.length === 2);
  assert.deepEqual(agentCalls[1].images, []);
  assert.ok(!agentCalls[1].userText.includes("附图说明"));
  action = "send";
  h.inbound(msg({ ...owner, text: "发下头像" }));
  await waitFor(() => sent.length === 1);
  assert.deepEqual(sent[0].messages, [{ type: 10, url: "https://h/uploads/1/bot_avatar.jpeg" }]);  // 平台头像本身有 url，不上传
  assert.equal(uploads.length, 0);
  fs.writeFileSync(path.join(dir, "ws", "avatar.png"), Buffer.from("local-png"));  // 放了本地文件：优先用它，发前上传一次、之后走缓存
  h.inbound(msg({ ...owner, text: "再发一次" }));
  await waitFor(() => sent.length === 2);
  assert.equal(uploads.length, 1);
  assert.match(sent[1].messages[0].url, /^https:\/\/h\/uploads\/1\/chat\/avatar_1_\d+-\d+\.png$/);
  h.inbound(msg({ ...owner, text: "再发一次" }));
  await waitFor(() => sent.length === 3);
  assert.equal(uploads.length, 1);
  assert.equal(sent[2].messages[0].url, sent[1].messages[0].url);
  action = "save";  // 主人发图说存成头像：存本地；源图在平台托管就直接记可发送地址
  h.inbound(msg({ ...owner, type: "文件", url: "https://h/uploads/1/chat/me.png", isImage: true }));
  h.inbound(msg({ ...owner, text: "存成头像" }));
  await waitFor(() => sent.length === 4);
  assert.equal(sent[3].messages[0].content, "存好了");
  assert.equal(fs.readFileSync(path.join(dir, "ws", "avatar.png"), "utf8"), "png");  // 假下载的内容
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "ws", "avatar.json"), "utf8")).url, "https://h/uploads/1/chat/me.png");
  action = "send";
  h.inbound(msg({ ...owner, text: "发头像" }));
  await waitFor(() => sent.length === 5);
  assert.equal(sent[4].messages[0].url, "https://h/uploads/1/chat/me.png");
  assert.equal(uploads.length, 1);
  await close();
});

test("分条与 say：--- 主动分条按顺序发、只有本轮第一条补 @（开头就是 --- 也不会把分隔符带进正文）；say 先发再发图再收尾顺序保持；say 过的话最后原样重复就不发；条数上限后最后回复仍能发一条", async () => {
  let mode = "split";
  const respond = async ({ tools }) => {
    const tool = (n) => tools.find((t) => t.name === n);
    if (mode === "split") return { text: "先说结论\n---\n再说原因\n---\n最后建议", reason: "end_turn" };
    if (mode === "lead") return { text: "---\n开头就是分隔符\n---\n第二条", reason: "end_turn" };
    if (mode === "interleave") {
      await tool("say").run({ text: "看这张" });
      await tool("send_image").run({ url: "https://h/uploads/1/chat/a.png" });
      return { text: "就是它", reason: "end_turn" };
    }
    if (mode === "dup") { await tool("say").run({ text: "说完了" }); return { text: "说完了", reason: "end_turn" }; }
    for (let i = 1; i <= 6; i++) {
      try { await tool("say").run({ text: `第${i}条` }); } catch (e) { return { text: e.message, reason: "end_turn" }; }
    }
    return { text: "没拦住", reason: "end_turn" };
  };
  const { h, sent, events, close } = await boot({ respond, config: { limits: { minIntervalMs: 1, quietHours: { enabled: false }, split: { maxChars: 800, maxParts: 5 } } } });
  const agents = () => events.filter((e) => e.ev === "agent").length;
  h.inbound(msg({ text: "先聊点别的", sender: { id: "wxid_b", name: "老王" } }));
  h.inbound(msg({ text: "@helper 怎么看" }));
  await waitFor(() => sent.length === 3);
  assert.deepEqual(sent.map((s) => s.messages[0].content), ["@小明 先说结论", "再说原因", "最后建议"]);
  assert.equal(events.find((e) => e.ev === "outbound").parts, 3);
  mode = "lead";
  h.inbound(msg({ text: "@helper 再来" }));
  await waitFor(() => sent.length === 5);
  assert.deepEqual(sent.slice(3).map((s) => s.messages[0].content), ["@小明 开头就是分隔符", "第二条"]);  // 先分条再补 @
  mode = "interleave";
  h.inbound(msg({ text: "@helper 图呢" }));
  await waitFor(() => sent.length === 8);
  assert.deepEqual(sent.slice(5).map((s) => s.messages[0].content ?? s.messages[0].url), ["@小明 看这张", "https://h/uploads/1/chat/a.png", "就是它"]);
  assert.equal(events.filter((e) => e.ev === "outbound" && e.origin === "say").length, 1);
  mode = "dup";
  h.inbound(msg({ text: "@helper 完了吗" }));
  await waitFor(() => agents() === 4);
  await sleep(30);
  assert.equal(sent.length, 9);
  assert.equal(sent[8].messages[0].content, "@小明 说完了");
  assert.ok(events.some((e) => e.ev === "dropped" && e.reason === "repeat-of-say"));
  mode = "cap";
  h.inbound(msg({ text: "@helper 数数" }));
  await waitFor(() => agents() === 5);
  await waitFor(() => sent.length === 15);  // 5 条 say + 最后 1 条（报错文本，最后回复至少能发一条）
  assert.deepEqual(sent.slice(9, 14).map((s) => s.messages[0].content), ["@小明 第1条", "第2条", "第3条", "第4条", "第5条"]);
  assert.match(sent[14].messages[0].content, /say 已发 5 条、配额用完了/);
  await close();
});

test("模型正文末尾夹带 NO_REPLY（多半跟在漏出的思考标记后面）：正文照发、标记去掉；整条只有 NO_REPLY 才不发", async () => {
  let reply = "好的，我记清楚啦，和群里任何真人都没关系~NO_REPLY";  // 思考标记本身在 agent 层已清
  const { h, sent, events, close } = await boot({ respond: () => ({ text: reply, reason: "end_turn" }) });
  h.inbound(msg({ text: "@helper 记住了吗" }));
  await waitFor(() => sent.length === 1);
  assert.deepEqual(sent[0].messages, [{ type: 1, content: "好的，我记清楚啦，和群里任何真人都没关系~" }]);
  reply = "「NO_REPLY」";
  h.inbound(msg({ text: "@helper 再来" }));
  await waitFor(() => events.filter((e) => e.ev === "agent").length === 2);
  await sleep(30);
  assert.equal(sent.length, 1);
  await close();
});

test("出站队列落盘：上次没发完的启动后续发，超过 maxWaitMs 的丢弃；发完文件清空", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
  fs.mkdirSync(path.join(dir, "ws"), { recursive: true });
  const file = path.join(dir, "ws", "outbox.json");
  const conv = { id: OWNER, isGroup: false, name: "主人" };
  fs.writeFileSync(file, JSON.stringify([
    { conv, messages: [{ type: 1, content: "没发完的" }], mentions: [], ts: Date.now() },
    { conv, messages: [{ type: 1, content: "太旧的" }], mentions: [], ts: Date.now() - 10 * 60_000 },
    null, {}, { conv: {}, messages: [] }, { conv, messages: "不是数组", ts: Date.now() },  // 写坏的条目：跳过，不能崩、不能卡死队列
    { conv, messages: [{ type: 1, content: "没有 ts" }], mentions: [] },                      // 缺 ts 会让 isStale 失效，也跳过
    { conv, messages: [null], mentions: [], ts: Date.now() },                                // 元素形状不对，跳过
    { conv, messages: [{ type: 1, content: "带了 log 字段" }], mentions: [], ts: Date.now(), log: {} },  // 旧版本 / 手改留下的 log:{} 是真值，恢复时必须剔掉
  ]));
  const { sent, events, lines, close } = await boot({ dir });
  await waitFor(() => sent.length === 2 && events.some((e) => e.ev === "dropped" && e.reason === "stale-outbox"));
  assert.ok(lines.some((l) => l.msg === "续发上次没发完的出站消息 2 条（6 条结构不对已跳过，1 条超过 limits.maxWaitMs 已丢弃）"));  // 只算真会发的
  await sleep(50);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => s.messages[0].content), ["没发完的", "带了 log 字段"]);  // 带 log:{} 的也能发出去（剔掉后用默认日志器）
  assert.ok(!fs.existsSync(file + ".restoring"));  // 取走的快照读完即删
  await close();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
});

test("平台侧健康检查：不是 running 就在启动时报出来（带该做什么），running 安静、缺 botState 不报假警", async () => {
  const scan = await boot({ statusFn: () => ({ botState: "scan_pending", botStateLabel: "等待扫码", name: "helper" }) });
  const errs = scan.lines.filter((l) => l.level === "error" && l.msg.includes("平台机器人"));
  assert.equal(errs.length, 1);
  assert.match(errs[0].msg, /等待扫码（scan_pending）/);
  assert.match(errs[0].msg, /扫码登录/);           // 给出该做什么
  assert.match(errs[0].msg, /收不到/);             // 说明后果：这期间收不到消息
  await scan.close();

  const run = await boot({ statusFn: () => ({ botState: "running", botStateLabel: "在线且已登录" }) });
  assert.equal(run.lines.filter((l) => l.level === "error" && l.msg.includes("平台机器人")).length, 0);
  assert.equal(run.lines.filter((l) => l.msg.includes("平台机器人已在线")).length, 1);  // 首次就是 running 也留一句
  await run.close();

  const stopped = await boot({ statusFn: () => ({ botState: "stopped", botStateLabel: "已停止" }) });
  assert.match(stopped.lines.find((l) => l.msg.includes("平台机器人")).msg, /点「启动」/);
  await stopped.close();

  const missing = await boot({ statusFn: () => ({}) });   // 平台没给 botState（老版本）：不猜、不报假警
  assert.equal(missing.lines.filter((l) => l.msg.includes("平台机器人")).length, 0);
  await missing.close();

  const broken = await boot({ statusFn: () => { throw new Error("status 接口 500"); } });
  assert.ok(broken.lines.some((l) => l.level === "warn" && /查询平台机器人状态失败/.test(l.msg)));
  await broken.close();
});

test("健康检查：checkMinutes 0 只在启动查一次；state 没变不重复记", async () => {
  let calls = 0;
  const { lines, close } = await boot({ statusFn: () => { calls++; return { botState: "running", botStateLabel: "在线且已登录" }; }, config: { health: { checkMinutes: 0 } } });
  assert.equal(calls, 1);
  await sleep(50);
  assert.equal(calls, 1);  // 关了周期检查，不再查
  assert.equal(lines.filter((l) => /平台机器人/.test(l.msg)).length, 1);
  await close();
});

const LOCK = (dir) => path.join(dir, "ws", "harness.lock");

test("单实例锁：同一个 workspace 另一个活着的 harness 占着就拒绝启动；锁里的 pid 已不在就接管；close 删锁", async () => {
  const a = await boot();
  assert.equal(fs.readFileSync(LOCK(a.dir), "utf8"), String(process.pid));
  await assert.rejects(boot({ dir: a.dir }), /正被另一个 harness（pid \d+）使用/);
  await a.close();
  assert.ok(!fs.existsSync(LOCK(a.dir)));
  const { spawnSync } = await import("node:child_process");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;  // 刚退出的进程：崩溃留下的过期锁
  fs.writeFileSync(LOCK(a.dir), String(dead));
  const b = await boot({ dir: a.dir });
  assert.equal(fs.readFileSync(LOCK(b.dir), "utf8"), String(process.pid));
  await b.close();
  const c = await boot({ dir: a.dir, deps: { makeApi: () => ({ bot: async () => { throw new Error("平台连不上"); } }) } }).catch((e) => e);
  assert.match(c.message, /平台连不上/);
  assert.ok(!fs.existsSync(LOCK(a.dir)));  // 启动失败也放锁
});

test("续发积压在等 OpenClaw 连上时被关：积压不丢（关闭时照发 / 留在盘上），不再像以前那样整批消失", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
  fs.mkdirSync(path.join(dir, "ws"), { recursive: true });
  const file = path.join(dir, "ws", "outbox.json");
  fs.writeFileSync(file, JSON.stringify([{ conv: { id: OWNER, isGroup: false, name: "主人" }, messages: [{ type: 1, content: "积压" }], mentions: [], ts: Date.now() }]));
  const { sent, close } = await boot({ dir, account: { apiSecret: "s", clawConfig: { open: true } } });  // OpenClaw 一直没连上
  await sleep(200);
  assert.equal(sent.length, 0);  // 还在等 OpenClaw
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);  // 但已经重新入队落盘：这时崩了也不丢
  await close();
  assert.deepEqual(sent.map((s) => s.messages[0].content), ["积压"]);  // 关闭时不再等，照发（OpenClaw 没连上就走 HTTP）
});

test("关闭：防抖里还在等的触发立刻进 lane、等这一轮答完发出去再收尾；记忆最后落盘", async () => {
  const { h, dir, sent, events, close } = await boot({
    config: { agent: { baseUrl: "https://llm", token: "k", model: "m", debounceMs: 60_000 } },  // 防抖窗口很长：不 flush 就永远等不到
    respond: async () => { await sleep(150); return { text: "来了", reason: "end_turn" }; },
  });
  h.inbound(msg({ conv: OWNER, sender: { id: OWNER, name: "主人" }, text: "在吗" }));
  await close();
  assert.deepEqual(sent.map((s) => s.messages[0].content), ["来了"]);
  assert.ok(!events.some((e) => e.ev === "dropped"));
  assert.equal(readCtx(dir, OWNER).at(-1).text, "来了");
});

test("关闭：等 lane 到时限还没答完的，每条触发记 dropped: shutdown，作废后答完也不发", async (t) => {
  let release;
  const { h, sent, events, agentCalls, close } = await boot({ respond: () => new Promise((r) => { release = () => r({ text: "迟到的回复", reason: "end_turn" }); }) });
  h.inbound(msg({ conv: OWNER, sender: { id: OWNER, name: "主人" }, text: "在吗" }));
  await waitFor(() => agentCalls.length === 1);
  h.inbound(msg({ conv: OWNER, sender: { id: OWNER, name: "主人" }, text: "还在吗" }));  // 排在同一条 lane 后面，还没开始
  await sleep(20);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const closed = close();
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await closed;
  t.mock.timers.reset();
  const drops = events.filter((e) => e.ev === "dropped" && e.reason === "shutdown");
  assert.equal(drops.length, 2);
  assert.ok(drops.every((d) => d.conv === OWNER && d.from === OWNER && d.id));
  release();
  await sleep(50);
  assert.equal(sent.length, 0);
  assert.equal(agentCalls.length, 1);  // 排队的那轮没再开始
});

test("外站图搬运在本轮里做、只重试 1 次、平台主机名豁免私网校验；搬图慢不堵别的会话的出站", async () => {
  const downloads = [];
  const fetchImageData = async (url, opts) => {
    downloads.push({ url, ...opts });
    if (url.includes("slow.example")) await sleep(300);
    return { mediaType: "image/png", base64: "AAAA", buffer: Buffer.from("png") };
  };
  const respond = async ({ tools, userText }) => {
    if (/发图/.test(userText)) await tools.find((x) => x.name === "send_image").run({ url: "https://slow.example/pic.png" });
    return { text: /发图/.test(userText) ? "NO_REPLY" : "文字回复", reason: "end_turn" };
  };
  const { h, sent, close } = await boot({ respond, account: { apiSecret: "s" }, deps: { fetchImageData } });
  h.inbound(msg({ conv: OWNER, sender: { id: OWNER, name: "主人" }, text: "发图" }));
  await sleep(50);
  h.inbound(msg({ text: "@helper 在吗" }));  // 另一个会话
  await waitFor(() => sent.length === 2);
  assert.equal(sent[0].messages[0].content, "文字回复");  // 没被搬图堵住
  assert.match(sent[1].messages[0].url, /^https:\/\/h\/uploads\/1\/chat\/harness_\d+\.png$/);
  assert.equal(downloads[0].retries, 1);
  assert.deepEqual(downloads[0].trustedHosts, ["h"]);
  await close();
});

test("看图：模型不认的格式（bmp）不给看、记 warn；插嘴那一轮哪怕是主人触发也不给主人工具", async () => {
  const { h, agentCalls, events, lines, close } = await boot({
    config: { images: { vision: true }, groups: { allow: [ROOM], warmupHistory: 0, chime: { enabled: true, cooldownMinutes: 1, probability: 1 } } },
    deps: { fetchImageData: async () => ({ mediaType: "image/bmp", base64: "Qk0=", buffer: Buffer.from("BM") }) },
  });
  h.inbound(msg({ type: "文件", url: "https://x/pic.bmp", isImage: true, sender: { id: "wxid_b", name: "老王" } }));
  h.inbound(msg({ text: "@helper 这图啥意思" }));
  await waitFor(() => agentCalls.length === 1);
  assert.deepEqual(agentCalls[0].images, []);
  assert.ok(lines.some((l) => l.level === "warn" && /image\/bmp.*不给看/.test(l.msg)));
  await waitFor(() => events.some((e) => e.ev === "agent"));
  assert.equal(events.find((e) => e.ev === "agent").imageEncoding, "unsupported");
  await sleep(20);
  h.inbound(msg({ conv: "g2@chatroom", text: "随便聊聊", sender: { id: OWNER, name: "主人" }, type: "文字" }));  // 群 g2 不在白名单：不插嘴
  h.inbound(msg({ text: "今天天气不错", sender: { id: OWNER, name: "主人" } }));  // 主人在白名单群里闲聊，没叫 bot → 插嘴
  await waitFor(() => agentCalls.length >= 2);
  const names = agentCalls.at(-1).tools.map((x) => x.name);
  assert.ok(!names.includes("send_message") && !names.includes("platform") && !names.includes("save_sticker"));
  await close();
});

test("clientId 后缀带分隔符（入站 _、OpenClaw -）；预热成员跳过黑名单；往没登记过的群发文字每群提醒一次、照常发", async () => {
  const conns = [];
  // 群历史给预热用；私聊历史走真实的 fetchHistory（主人身份核对查的是它，落到假 api 的注入记录上）
  const history = async (api, cfg, target, opts) => (target.isGroup ? { rows: [
    { chatUserId: "wxid_bad", chatUserName: "捣乱的" },
    { chatUserId: "wxid_ok", chatUserName: "正常人" },
  ], pagination: null } : fetchHistory(api, cfg, target, opts));
  const respond = async ({ tools }) => {
    const sm = tools.find((x) => x.name === "send_message");
    await sm.run({ conversation: "new@chatroom", text: "你好" });
    await sm.run({ conversation: "new@chatroom", text: "再来" });
    return { text: "NO_REPLY", reason: "end_turn" };
  };
  const { h, dir, sent, lines, close } = await boot({
    respond, account: { apiSecret: "s", clawConfig: { open: true } },
    config: { network: { mqttClientIdSuffix: "x" }, blockedSenders: ["wxid_bad"], groups: { allow: [ROOM], warmupHistory: 50 } },
    deps: {
      startMqtt: (o) => { conns.push(["in", o.clientId]); return { close() {} }; },
      startOpenClawSender: (o) => { conns.push(["oc", o.clientIdSuffix]); return { connected: () => false, publish: async () => {}, close() {} }; },
      fetchHistory: history,
    },
  });
  assert.deepEqual(conns, [["oc", "-harness-x"], ["in", "harness_1_x"]]);
  h.inbound(msg({ conv: OWNER, sender: { id: OWNER, name: "主人" }, text: "去新群打个招呼" }));
  await waitFor(() => sent.length === 2);
  assert.equal(lines.filter((l) => l.level === "warn" && /没在这个群收到过消息，机器人可能不在群里/.test(l.msg)).length, 1);
  await close();
  const members = JSON.parse(fs.readFileSync(path.join(dir, "ws", "members.json"), "utf8"));
  assert.deepEqual(Object.keys(members[ROOM]), ["wxid_ok"]);
});

test("周期复查：后台中途开了 OpenClaw（或换了 apiSecret），重建出站连接；没变不重建", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let claw = false, ocStarts = 0;
  const { close } = await boot({
    config: { health: { checkMinutes: 1 } },
    deps: {
      makeApi: () => ({
        bot: async () => ({ name: "helper", robotId: BOT_WXID, apiSecret: "s", clawConfig: { open: claw }, recordConfig: { open: true } }),
        status: async () => ({}), history: async () => ({ rows: [] }), send: async () => {},
      }),
      startOpenClawSender: () => { ocStarts++; return { connected: () => true, publish: async () => {}, close() {} }; },
    },
  });
  assert.equal(ocStarts, 0);
  t.mock.timers.tick(60_000); await sleep(20);
  assert.equal(ocStarts, 0);
  claw = true;
  t.mock.timers.tick(60_000); await sleep(20);
  assert.equal(ocStarts, 1);
  t.mock.timers.tick(60_000); await sleep(20);
  assert.equal(ocStarts, 1);
  await close();
});

test("热更新：只改 HTTP 相关的 network 不重连、改 MQTT 相关的才重连；logs.keepDays 变了重建日志器；换 workspace 不重连、锁和出站落盘搬到新 workspace、旧 outbox.json 删掉", async () => {
  let mqStarts = 0;
  const logDirs = [], lines = [];
  const { h, dir, close } = await boot({
    deps: {
      startMqtt: () => { mqStarts++; return { close() {} }; },
      makeLog: (d, o) => {
        logDirs.push([d, o.keepDays]);
        const l = { info: (m) => lines.push({ level: "info", msg: m }), warn: (m) => lines.push({ level: "warn", msg: m }), error: (m) => lines.push({ level: "error", msg: m }), event() {}, with: () => l };
        return l;
      },
    },
  });
  const cfgFile = path.join(dir, "config.jsonc");
  const edit = async (patch) => { fs.writeFileSync(cfgFile, JSON.stringify(merge(JSON.parse(fs.readFileSync(cfgFile, "utf8")), patch))); await h.reload(); };
  assert.equal(mqStarts, 1);
  await edit({ network: { sendRetries: 5, apiTimeoutMs: 1000, platformTimeoutMs: 5000 } });  // 拉配置超时每次连接时现读：不用重连
  assert.equal(mqStarts, 1);
  await edit({ network: { mqttKeepalive: 45 } });
  assert.equal(mqStarts, 2);
  await edit({ logs: { keepDays: 7 } });
  assert.deepEqual(logDirs.at(-1), [path.join(dir, "ws", "logs"), 7]);
  const oldBox = path.join(dir, "ws", "outbox.json");
  fs.writeFileSync(oldBox, "[]");
  await edit({ workspace: "ws2" });
  assert.equal(mqStarts, 2);
  assert.ok(!fs.existsSync(oldBox));
  assert.ok(!fs.existsSync(LOCK(dir)));
  assert.equal(fs.readFileSync(path.join(dir, "ws2", "harness.lock"), "utf8"), String(process.pid));
  assert.ok(fs.existsSync(path.join(dir, "ws2", "outbox.json")));
  assert.ok(!lines.some((l) => l.level === "error"));
  await close();
  assert.ok(!fs.existsSync(path.join(dir, "ws2", "harness.lock")));
});

test("context.rosterSize：群里给模型的成员名单按它截（最近说话的优先）", async () => {
  const { h, agentCalls, close } = await boot({ config: { context: { rosterSize: 2 } } });
  for (const [id, name] of [["wxid_1", "甲"], ["wxid_2", "乙"], ["wxid_3", "丙"]]) h.inbound(msg({ text: "聊天", sender: { id, name } }));
  h.inbound(msg({ text: "@helper 在吗", sender: { id: "wxid_3", name: "丙" } }));
  await waitFor(() => agentCalls.length === 1);
  assert.match(agentCalls[0].userText, /本群你能 @ 到的人（在群里说过话的，2 位）：丙、乙\n/);
  await close();
});

test("微信表情：拉取断过一阵后补上来的旧表情只进上下文，私聊也不触发回复", async () => {
  const feed = [];
  let calls = 0;
  const { h, agentCalls, events, close } = await boot({
    config: { dm: { policy: "open" } },
    deps: { makeStickerFeed: () => async () => { calls++; return feed.splice(0); } },
  });
  await waitFor(() => calls === 1);  // 启动时拉一次
  feed.push({ id: "old", convId: "wxid_u", isGroup: false, senderId: "wxid_u", ts: Date.now() - 10 * 60_000, name: "旧", url: "http://wx/x", width: 1, height: 1 });
  await h.pollStickers();
  await sleep(50);
  assert.equal(agentCalls.length, 0);
  assert.deepEqual(events.filter((e) => e.ev === "dropped").map((e) => e.reason), ["stale"]);  // 超过 limits.maxWaitMs：按发送时间算，丢
  await close();
});

test("stickers.inboundPollSec：0 = 不拉 puppet 日志收微信表情；热更新打开后按间隔拉", async () => {
  let polls = 0;
  const { h, dir, close } = await boot({ config: { stickers: { inboundPollSec: 0 } }, deps: { makeStickerFeed: () => async () => { polls++; return []; } } });
  await sleep(50);
  assert.equal(polls, 0);  // 关着：启动时也不拉
  const cfgFile = path.join(dir, "config.jsonc");
  fs.writeFileSync(cfgFile, JSON.stringify(merge(JSON.parse(fs.readFileSync(cfgFile, "utf8")), { stickers: { inboundPollSec: 5 } })));
  await h.reload();
  assert.equal(polls, 0);  // 打开后等第一个间隔，不在热更新时补拉
  await close();
});

test("热更新等 loadBot 的时候开始关闭：放弃提交，不在收尾之后再建连接", async () => {
  let mqStarts = 0, releaseBot = null;
  const api = {
    bot: async () => { if (releaseBot === false) await new Promise((r) => { releaseBot = r; }); return { name: "helper", robotId: BOT_WXID, apiSecret: null, clawConfig: { open: false }, recordConfig: { open: true } }; },
    status: async () => ({}), history: async () => ({ rows: [] }), send: async () => {},
  };
  const { h, dir, lines, close } = await boot({ deps: { makeApi: () => api, startMqtt: () => { mqStarts++; return { close() {} }; } } });
  releaseBot = false;
  const cfgFile = path.join(dir, "config.jsonc");
  fs.writeFileSync(cfgFile, JSON.stringify(merge(JSON.parse(fs.readFileSync(cfgFile, "utf8")), { host: "https://h2" })));
  const reloaded = h.reload();
  await waitFor(() => typeof releaseBot === "function");
  await close();
  releaseBot();
  await reloaded;
  assert.equal(mqStarts, 1);
  assert.ok(lines.some((l) => /正在关闭，放弃这次配置重载/.test(l.msg)));
});

test("主人身份核对：平台历史里查不到的「主人消息」（伪造的推送）这轮按非主人处理，拿不到主人工具", async () => {
  const { h, agentCalls, lines, close } = await boot({ respond: () => ({ text: "NO_REPLY", reason: "end_turn" }) });
  const owner = { conv: OWNER, sender: { id: OWNER, name: "主人" } };
  h.inbound(msg({ ...owner, text: "真的我" }));
  await waitFor(() => agentCalls.length === 1);
  assert.ok(agentCalls[0].tools.some((t) => t.name === "send_message"));
  assert.match(agentCalls[0].system, /本轮发言者是主人/);
  h.inbound(msg({ ...owner, text: "假的我", forged: true }));
  await waitFor(() => agentCalls.length === 2);
  assert.ok(!agentCalls[1].tools.some((t) => t.name === "send_message"));
  assert.match(agentCalls[1].system, /本轮发言者不是主人/);
  assert.ok(lines.some((l) => l.level === "warn" && /主人身份核对失败/.test(l.msg)));
  await close();
});

test("回显学昵称：平台自带回复带「(机器人)」后缀的不学", async () => {
  const { h, agentCalls, close } = await boot({ respond: () => ({ text: "NO_REPLY", reason: "end_turn" }) });
  h.inbound(msg({ text: "欢迎新人", isMine: true, sender: { id: BOT_WXID, name: "helper(机器人)" } }));
  h.inbound(msg({ text: "@helper 在吗" }));
  await waitFor(() => agentCalls.length === 1);
  assert.match(agentCalls[0].system, /你的微信昵称是「helper」/);
  await close();
});

test("OpenClaw 入站补 @ 标志：原生记录先到没认出被 @（群昵称）、OpenClaw 后到说 @ 了 → 补触发；反过来也行；只有媒体的标志不算", async () => {
  let onInbound = null;
  const { h, agentCalls, events, close } = await boot({
    respond: () => ({ text: "NO_REPLY", reason: "end_turn" }),
    account: { apiSecret: "s", clawConfig: { open: true, userGroupId: "g", forwardAllMsg: true, forwardMediaMsg: true } },
    deps: { startOpenClawSender: (a) => { onInbound = a.onInbound; return { connected: () => false, publish: async () => {}, close() {} }; } },
  });
  assert.equal(typeof onInbound, "function");
  const m1 = msg({ text: "@群里的小名 在吗" });  // 群昵称：文本里认不出
  h.inbound(m1);
  await sleep(20);
  assert.equal(agentCalls.length, 0);
  onInbound({ id: m1.id, isGroup: true, convId: ROOM, senderId: "wxid_a", type: "文字", mention: true, url: null });
  await waitFor(() => agentCalls.length === 1);
  assert.equal(events.filter((e) => e.ev === "inbound" && e.id === m1.id).at(-1).via, "openclaw");
  const m2 = msg({ text: "@群里的小名 再问一次" });
  onInbound({ id: m2.id, isGroup: true, convId: ROOM, senderId: "wxid_a", type: "文字", mention: true, url: null });  // OpenClaw 先到
  h.inbound(m2);
  await waitFor(() => agentCalls.length === 2);
  assert.equal(events.filter((e) => e.ev === "inbound" && e.id === m2.id)[0].reason, "mention");
  onInbound({ id: "self", isGroup: true, convId: ROOM, senderId: BOT_WXID, type: "文字", mention: true });  // 自己的不算
  const m3 = msg({ text: "随便聊聊" });
  h.inbound(m3);
  onInbound({ id: m3.id, isGroup: true, convId: ROOM, senderId: "wxid_a", type: "图片", mention: false, url: "https://bucket.oss-cn-hangzhou.aliyuncs.com/a.png" });  // 媒体没有 @ 标志
  const m4 = msg({ text: "对不上的" });
  h.inbound(m4);
  onInbound({ id: m4.id, isGroup: true, convId: "other@chatroom", senderId: "wxid_a", type: "文字", mention: true });  // id 对上了、会话对不上：不认
  await sleep(20);
  assert.equal(agentCalls.length, 2);
  await close();
});

test("图片搬运：平台域名、平台上传目录形态的图不搬；外站的先搬到平台；入站图片的主机不会被当成平台托管", async () => {
  const { h, uploads, sent, close } = await boot({
    account: { apiSecret: "s" },
    respond: async (args) => {
      for (const url of ["https://h/x/a.png", "https://cdn.other.test/uploads/7/chat/b.png", "https://i.imgur.com/c.png"]) await runToolByName(args, "send_image", { url });
      return { text: "NO_REPLY", reason: "end_turn" };
    },
    config: { limits: { minIntervalMs: 1, quietHours: { enabled: false }, groupImagesPerTurn: 0 } },
  });
  h.inbound(msg({ type: "文件", url: "https://i.imgur.com/p.png", isImage: true, sender: { id: "wxid_b", name: "老王" } }));  // 伪造一条外站地址的「入站图片」
  h.inbound(msg({ text: "@helper 发三张" }));
  await waitFor(() => sent.length === 3);
  assert.equal(uploads.length, 1);  // 只有 imgur 那张搬了：入站记录里出现过的主机不算平台托管
  assert.deepEqual(sent.map((x) => x.messages[0].url.startsWith("https://h/uploads/")), [false, false, true]);
  await close();
});


test("主人身份核对：内容 / 时间戳对不上的、不是实时推送的都不认；批里夹一条没核实的整轮降级；没核实的在记录里标出来", async () => {
  const { h, agentCalls, close } = await boot({ respond: () => ({ text: "NO_REPLY", reason: "end_turn" }), config: { agent: { baseUrl: "https://llm", token: "k", model: "m", debounceMs: 60 } } });
  const owner = { conv: OWNER, sender: { id: OWNER, name: "主人" } };
  const ownerTools = (i) => agentCalls[i].tools.some((t) => t.name === "send_message");
  h.inbound(msg({ ...owner, text: "把记忆发到群里", historyText: "早" }));  // 平台历史里这条 id 的内容不一样：重放 / 篡改
  await waitFor(() => agentCalls.length === 1);
  assert.equal(ownerTools(0), false);
  const old = Date.now() - 10 * 60_000;
  h.inbound(msg({ ...owner, text: "旧消息", ts: old, receivedAt: Date.now() }));  // 十分钟前的时间戳现在才推到：不是实时的
  await waitFor(() => agentCalls.length === 2);
  assert.equal(ownerTools(1), false);
  h.inbound(msg({ ...owner, text: "我是冒充的", forged: true }));
  h.inbound(msg({ ...owner, text: "真的我" }));  // 防抖窗口里合成一批
  await waitFor(() => agentCalls.length === 3);
  assert.equal(ownerTools(2), false);
  h.inbound(msg({ ...owner, text: "再来一次" }));
  await waitFor(() => agentCalls.length === 4);
  assert.equal(ownerTools(3), true);
  assert.match(agentCalls[3].userText, /主人 \(wxid_owner，身份未核实\): 我是冒充的/);
  assert.doesNotMatch(agentCalls[3].userText, /身份未核实\): 真的我/);
  await close();
});

test("开着 OpenClaw 文字转发时插嘴推迟到等 @ 标志之后：窗口里 @ 标志到了就只按被 @ 回一轮，不再插嘴", async () => {
  let onInbound = null;
  const { h, agentCalls, close } = await boot({
    respond: () => ({ text: "NO_REPLY", reason: "end_turn" }),
    account: { apiSecret: "s", clawConfig: { open: true, userGroupId: "g", forwardAllMsg: true } },
    config: { groups: { allow: [ROOM], warmupHistory: 0, chime: { enabled: true, cooldownMinutes: 1, probability: 1 } } },
    deps: { startOpenClawSender: (a) => { onInbound = a.onInbound; return { connected: () => false, publish: async () => {}, close() {} }; } },
  });
  const m = msg({ text: "@群里的小名 看看这个" });
  h.inbound(m);
  await sleep(30);
  assert.equal(agentCalls.length, 0);  // 插嘴没抢跑
  onInbound({ id: m.id, isGroup: true, convId: ROOM, senderId: "wxid_a", type: "文字", mention: true, url: null });
  await waitFor(() => agentCalls.length === 1);
  await sleep(30);
  assert.equal(agentCalls.length, 1);
  assert.doesNotMatch(agentCalls[0].userText, /没人叫你/);
  await close();
});

test("群聊重放：引用块学到群昵称后，@小白 / @alice / 艾特所有人都 @ 对人；名单带群昵称；平台收到的 mentionIds 正确", async () => {
  const published = [];
  const replies = ["@小白 看这里", "@alice 起床", "@carol @小白 @Alice 都睡觉"];
  let i = 0;
  const { h, agentCalls, events, close } = await boot({
    account: { apiSecret: "s", clawConfig: { open: true } },
    deps: { startOpenClawSender: () => ({ connected: () => true, publish: async (p) => { published.push(p); }, close() {} }) },
    respond: () => ({ text: replies[i++], reason: "end_turn" }),
  });
  const say = (id, name, text) => h.inbound(msg({ text, sender: { id, name } }));
  say("wxid_c", "Bobby", "感觉，这个号的讲话风格，跟老大很像");
  say("wxid_k", "Alice", "我在吃饭");
  say("wxid_c", "Bobby", "「小白：感觉，这个号的讲话风格，跟老大很像」\n- - - - - - - - - - - - - - -\n哈哈");
  say(OWNER, "carol", "@helper 艾特一下小白");
  await waitFor(() => published.length === 1);
  assert.match(agentCalls[0].userText, /Bobby（群里叫 小白）/);
  assert.match(agentCalls[0].userText, /Alice/);
  say(OWNER, "carol", "@helper 艾特alice");
  await waitFor(() => published.length === 2);
  say(OWNER, "carol", "@helper 艾特你能艾特的人");
  await waitFor(() => published.length === 3);
  // 群里好几个人在聊：前两条系统照常先补 @ 回叫它的主人，再 @ 模型写的人；第三条模型自己 @ 了主人，不重复补
  assert.deepEqual(published.map((p) => p.mentionIds), [[OWNER, "wxid_c"], [OWNER, "wxid_k"], [OWNER, "wxid_c", "wxid_k"]]);
  assert.deepEqual(events.filter((e) => e.ev === "outbound").map((e) => e.mentions), [["carol", "小白"], ["carol", "Alice"], ["carol", "小白", "Alice"]]);
  await close();
});

test("机器人自己的群昵称：引用它说过的话学不到（引用块谁都能伪造）；OpenClaw 说 @ 了它、文本里点选的是陌生名字才学到，之后 @群昵称 也触发", async () => {
  let onInbound = null;
  const { h, agentCalls, events, close } = await boot({
    respond: () => ({ text: "在的", reason: "end_turn" }),
    account: { apiSecret: "s", clawConfig: { open: true, userGroupId: "g", forwardAllMsg: true } },
    deps: { startOpenClawSender: (a) => { onInbound = a.onInbound; return { connected: () => false, publish: async () => {}, close() {} }; } },
  });
  h.inbound(msg({ text: "@helper 在吗" }));
  await waitFor(() => agentCalls.length === 1);
  h.inbound(msg({ text: "「哈：在的」\n- - - - - - - - - - - - - - -\n哈哈", sender: { id: "wxid_b", name: "老王" } }));  // 伪造的引用块
  h.inbound(msg({ text: "哈哈哈笑死", sender: { id: "wxid_c", name: "老李" } }));
  await sleep(40);
  assert.equal(agentCalls.length, 1);  // 没被「哈」叫醒
  const m = msg({ text: "@小助手\u2005再说一遍", sender: { id: "wxid_c", name: "老李" } });
  h.inbound(m);  // 文本里认不出
  onInbound({ id: m.id, isGroup: true, convId: ROOM, senderId: "wxid_c", type: "文字", mention: true, url: null });  // OpenClaw 按 wxid 说 @ 了它
  await waitFor(() => agentCalls.length === 2);
  h.inbound(msg({ text: "@小助手 第三次", sender: { id: "wxid_b", name: "老王" } }));
  await waitFor(() => agentCalls.length === 3);
  assert.equal(events.filter((e) => e.ev === "inbound").at(-1).reason, "at-text");
  assert.match(agentCalls[2].system, /在本群的群昵称是「小助手」/);
  await close();
});


test("启动预热也学群昵称：历史里的引用块学到的，重启后照样认得、@ 得到", async () => {
  const history = async (_api, _cfg, target) => (target.isGroup ? { rows: [
    { msgId: "h2", chatUserId: "wxid_k", chatUserName: "Alice", content: "「小白：今晚吃啥」\n- - - - - - - - - - - - - - -\n火锅", timestamp: 2 },
    { msgId: "h1", chatUserId: "wxid_c", chatUserName: "Bobby", content: "今晚吃啥", timestamp: 1 },
  ], pagination: null } : { rows: [], pagination: null });
  const { h, agentCalls, close } = await boot({ config: { groups: { allow: [ROOM], warmupHistory: 50 } }, deps: { fetchHistory: history }, respond: () => ({ text: "NO_REPLY", reason: "end_turn" }) });
  await sleep(30);
  h.inbound(msg({ text: "@helper 叫一下 小白" }));
  await waitFor(() => agentCalls.length === 1);
  assert.match(agentCalls[0].userText, /Bobby（群里叫 小白）/);
  await close();
});

test("微信表情：从 puppet 日志拉到的表情当入站消息进上下文，带名称；主人说「存成表情」时先搬到平台再入库", async () => {
  const feed = [];
  const { h, dir, uploads, agentCalls, events, close } = await boot({
    account: { apiSecret: "s" },
    deps: {
      makeStickerFeed: () => async () => feed.splice(0),
      fetchImageData: async () => ({ mediaType: "image/gif", base64: "R0lG", buffer: Buffer.from("gif") }),
    },
    respond: async (args) => { await runToolByName(args, "save_sticker", { items: [{ name: "坏蛋" }] }); return { text: "存好了", reason: "end_turn" }; },
  });
  h.inbound(msg({ text: "发个表情给你", sender: { id: OWNER, name: "主人" } }));  // 先说过话：成员表里有他的名字
  feed.push({ id: "e1", convId: ROOM, isGroup: true, senderId: OWNER, ts: Date.now(), name: "坏蛋", url: "http://wxapp.tc.qq.com/262/20304/stodownload?m=x", width: 240, height: 240 });
  await h.pollStickers();
  assert.deepEqual(events.filter((e) => e.ev === "inbound" && e.id === "e1").map((e) => [e.type, e.verdict, e.name]), [["表情", "context", "主人"]]);
  h.inbound(msg({ text: "@helper 存成表情 坏蛋", sender: { id: OWNER, name: "主人" } }));
  await waitFor(() => agentCalls.length === 1 && uploads.length === 1);
  assert.match(agentCalls[0].userText, /主人 \(wxid_owner\): \[表情：坏蛋\]/);  // 微信 CDN 的临时地址搬到了平台
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "ws", "stickers.json"), "utf8"));
  assert.deepEqual(saved.map((x) => [x.name, x.url.startsWith("https://h/uploads/")]), [["坏蛋", true]]);
  await close();
  const e1 = readCtx(dir, ROOM).find((x) => x.id === "e1");
  assert.deepEqual({ type: e1.type, sticker: e1.sticker, isImage: e1.isImage, unverified: e1.unverified }, { type: "表情", sticker: "坏蛋", isImage: true, unverified: undefined });
});

test("存表情的工具按这一轮触发者的原话给（去掉 @机器人）：只发图没说存，这轮就没有 save_sticker", async () => {
  const { h, agentCalls, close } = await boot();
  h.inbound(msg({ type: "文件", url: "https://h/uploads/1/chat/a.png", isImage: true, sender: { id: OWNER, name: "主人" } }));
  h.inbound(msg({ text: "@helper 发个你最新的表情包来看看", sender: { id: OWNER, name: "主人" } }));
  await waitFor(() => agentCalls.length === 1);
  assert.ok(!agentCalls[0].tools.some((t) => t.name === "save_sticker"));
  h.inbound(msg({ text: "@helper 存成表情 点赞", sender: { id: OWNER, name: "主人" } }));
  await waitFor(() => agentCalls.length === 2);
  assert.ok(agentCalls[1].tools.some((t) => t.name === "save_sticker"));
  await close();
});
