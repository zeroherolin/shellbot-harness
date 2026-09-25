// 从 puppet 日志里扒平台没给的东西：微信表情（平台不记录）、引用消息指向的原消息 id（平台只给「昵称：原文」）、
// 入站图片的可缩放 OSS 地址（平台只给不能缩放的上传目录地址）。群友发的文字也会进日志，只认 puppet 自己的日志行（见 chatTexts）。
// 日志经 GET /bots/:id/logs 拿，只留最后 1000 行；格式是 puppet 的内部实现，变了就静默拿不到，不影响别的功能。
import { sleep, toMillis, decodedUrl, safeSlice, oneLine } from "./util.js";

const OSS_LOOKUP_DELAY_MS = 1500;  // 学 OSS 地址的重试间隔
const OSS_LOOKUP_RETRIES = 2;      // 刚收到的图 puppet 日志可能还没写到：最多再翻这么多次（找不到就存原图，照样能发）
const STICKER_SEEN_MAX = 2000;     // 记住见过的表情 id 这么多个：日志最多 1000 行、一个表情占两行，足够

// ---- 微信表情（入站） ----
// 平台收消息时没有处理微信表情（消息类型 47）：不写历史、不推原生 MQTT，harness 本来一张也收不到。
// 但 puppet 日志里有原始载荷：一行「event------- {json}」，payload.msg 是表情 XML，带 CDN 地址（能下载成 gif / png）
// 和名称——表情商店里的名称在 desc、自己加的有时在 emojiattr，都是 base64 的 protobuf。harness 定时拉日志补上（harness.pollStickers），拉得不够勤会漏。

const EMOJI_MSG_TYPE = 47;
const EMOJI_NAME_MAX = 20;  // 表情名字最多留这么多字（进上下文，也可能被存成图库名）
const RECENT_TEXTS_MAX = 500;      // 表情拉取跨轮记住最近这么多条群友原文（见 chatTexts）

// ---- 分清 puppet 自己的日志行和群友发的文字 ----
// pm2 给每一行加前缀「2026-09-25 22:26 +08:00: 」。puppet 把收到的文字打成「收到群【…】消息(talker: …)：正文」，多行正文的每一行
// 也单独加了前缀：群友把某一行写成「22:26:49 INFO event------- {…}」，和 puppet 自己的日志行就一模一样，整行锚定也拦不住。
// 但每条消息的原文先已经在它自己的「Received payload」行里（JSON 转义成一行），所以：正文出现在某条原文里的行，一律当聊天内容，不当日志。
const PM2_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}: /;
const logLine = (kind) => new RegExp(`${PM2_PREFIX.source}\\d{2}:\\d{2}:\\d{2} INFO ${kind} (\\{.*\\})$`, "s");
const EVENT_LINE = logLine("event-------");         // puppet 的事件行：payload.msg 是消息 XML
const PAYLOAD_LINE = logLine("Received payload");   // puppet 的收消息行：data.content 是原文（文字或 appmsg XML）
const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");

/**
 * 日志里群友发过的原文（Received payload 的 data.content）。文字消息原样；引用这类 appmsg 的正文在 XML 里是转义过的，再加一份反转义的。
 * 伪造的 payload 行混进来也无妨：只会让更多行被当成聊天内容。
 */
function chatTexts(lines) {
  const out = [];
  for (const line of lines) {
    const m = PAYLOAD_LINE.exec(line);
    if (!m) continue;
    let c;
    try { c = JSON.parse(m[1])?.data?.content; } catch { continue; }
    if (typeof c !== "string" || !c) continue;
    out.push(c);
    const plain = unescapeXml(c);
    if (plain !== c) out.push(plain);
  }
  return out;
}
/** 这一行（去掉 pm2 前缀）是不是某条群友原文里的内容。 */
const isChatText = (line, texts) => { const body = line.replace(PM2_PREFIX, "").trim(); return !!body && texts.some((t) => t.includes(body)); };

/**
 * 从 puppet 日志行里解析出微信表情：[{ id, convId, isGroup, senderId, ts, name, url, width, height }]，按日志顺序。解析不了的行跳过。
 * 整行必须是 puppet 自己打的事件行，而且不是群友原文里的一行（见上）：否则有人发一段伪造的 JSON，就能冒充主人发的表情。
 * texts 默认取这份日志里的原文；表情拉取会并上前几轮见过的，免得原文那行刚好在上一轮、正文在这一轮。
 */
export function parseStickerEvents(lines, texts = chatTexts(lines)) {
  const out = [];
  for (const line of lines) {
    const m = EVENT_LINE.exec(line);
    if (!m || !line.includes("<emoji") || isChatText(line, texts)) continue;
    let p;
    try { p = JSON.parse(m[1])?.payload; } catch { continue; }
    if (!p || p.msgType !== EMOJI_MSG_TYPE || typeof p.id !== "string" || !p.id || typeof p.msg !== "string" || typeof p.fromWxid !== "string" || !p.fromWxid) continue;
    const isGroup = /@chatroom$/.test(p.fromWxid);
    const senderId = isGroup ? p.talkerId : p.fromWxid;
    if (typeof senderId !== "string" || !senderId) continue;
    const attr = (k) => xmlAttr(p.msg, k);
    const url = attr("cdnurl");
    if (!/^https?:\/\//.test(url)) continue;
    const name = emojiName(attr("desc"), attr("emojiattr"));
    out.push({
      id: p.id,
      convId: p.fromWxid,
      isGroup,
      senderId,
      ts: toMillis(p.timeStamp),
      name: name ? safeSlice(oneLine(name), EMOJI_NAME_MAX) : null,
      url,
      width: Number(attr("width")) || null,
      height: Number(attr("height")) || null,
    });
  }
  return out;
}

/** XML 属性值（表情 XML 里 = 两边可能有空格），反转义 &amp; 等。没有给空串。 */
function xmlAttr(xml, key) {
  const m = new RegExp(`\\s${key}\\s*=\\s*"([^"]*)"`).exec(xml);
  return m ? unescapeXml(m[1]) : "";  // &amp; 最后换：先换的话「&amp;lt;」会被多解一层成「<」
}

/**
 * 表情名称。desc：表情商店的，protobuf { 1: [ { 1: 语言, 2: 名称 } ] }，取 default（没有就 zh_cn、第一个）；
 * emojiattr：自己加的表情有时带，protobuf { 1: 名称 }。都没有给 null。解不开的忽略。
 */
function emojiName(desc, emojiattr) {
  try {
    const langs = protoFields(Buffer.from(desc, "base64")).filter((f) => f.no === 1 && f.bytes)
      .map((f) => Object.fromEntries(protoFields(f.bytes).filter((x) => x.bytes).map((x) => [x.no, utf8(x.bytes)])));
    const pick = langs.find((l) => l[1] === "default") || langs.find((l) => l[1] === "zh_cn") || langs[0];
    if (pick?.[2]) return pick[2].trim() || null;
  } catch {}
  try {
    const f = protoFields(Buffer.from(emojiattr, "base64")).find((x) => x.no === 1 && x.bytes);
    if (f) return utf8(f.bytes).trim() || null;
  } catch {}
  return null;
}
const utf8 = (b) => new TextDecoder("utf-8", { fatal: true }).decode(b);

/** 最小的 protobuf 读取：只认 varint 与长度前缀两种线型（表情这两个字段只用到这些），别的线型抛错。 */
function protoFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let x = 0, shift = 0, b;
    do { if (i >= buf.length) throw new Error("截断"); b = buf[i++]; x += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return x;
  };
  while (i < buf.length) {
    const key = varint(), no = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) out.push({ no, value: varint() });
    else if (wire === 2) { const n = varint(); if (i + n > buf.length) throw new Error("截断"); out.push({ no, bytes: buf.subarray(i, i + n) }); i += n; }
    else throw new Error(`不支持的线型 ${wire}`);
  }
  return out;
}

/**
 * 日志里的新表情：每次调用拉一遍 puppet 日志，只返回没见过的（按消息 id 记，最多记 STICKER_SEEN_MAX 个）。
 * 第一次成功拉到只记下现有的、不返回：启动时日志里那一小时的旧表情不该当新消息补进上下文。拉取失败往外抛，不算「记下了」。
 * getApi / getCfg 每次调用时取：热更新换了 token / host 也用新的（换 bot.id 由调用方重建 feed）。
 */
export function makeStickerFeed(getApi, getCfg) {
  const seen = new Set();
  let primed = false, recentTexts = [];
  return async function poll() {
    const lines = await fetchBotLogs(getApi(), getCfg(), { strict: true });
    recentTexts = [...new Set([...recentTexts, ...chatTexts(lines)])].slice(-RECENT_TEXTS_MAX);
    const events = parseStickerEvents(lines, recentTexts);
    const fresh = primed ? events.filter((e) => !seen.has(e.id)) : [];
    for (const e of events) seen.add(e.id);
    while (seen.size > STICKER_SEEN_MAX) seen.delete(seen.values().next().value);
    primed = true;
    return fresh;
  };
}

// ---- 引用（入站） ----
// 平台的记录和推送里，引用消息只有「昵称：图片 / 动画表情」文本，不说引的是哪条；按昵称找那人最近一张，他连发几张就会找错。
// puppet 日志里有原始载荷：一行「Received payload {json}」，data.content 是 appmsg XML，引用的 refermsg.svrid 就是被引那条的消息 id
// （和平台记录、微信表情用的是同一套 id，能直接在上下文里对上）。

/**
 * 日志里消息 msgId 引用的那条的 id（refermsg.svrid）；不是引用、日志里没有都返回 null。
 * 只认 puppet 自己的收消息行、不认群友原文里的一行（见 chatTexts）；XML 里的正文都转义过，伪造不出 <refermsg>。
 */
export function parseQuoteRef(lines, msgId, texts = chatTexts(lines)) {
  const id = String(msgId);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(id)) continue;
    const m = PAYLOAD_LINE.exec(lines[i]);
    if (!m || isChatText(lines[i], texts)) continue;
    let d;
    try { d = JSON.parse(m[1])?.data; } catch { continue; }
    if (!d || String(d.msg_id) !== id || typeof d.content !== "string") continue;
    const ref = /<refermsg>([\s\S]*?)<\/refermsg>/.exec(d.content)?.[1];
    return (ref && /<svrid>(\d+)<\/svrid>/.exec(ref)?.[1]) || null;
  }
  return null;
}

/**
 * 引用消息 msgId 引的是哪条：{ id, sticker }。id 是被引那条的消息 id；被引的是微信表情、同一份日志里还在，sticker 就是它的表情事件
 * （parseStickerEvents 的形状）——表情靠定时拉日志补进上下文，刚发就被引用时上下文里可能还没有。不是引用、日志里查不到返回 null。
 * puppet 收到消息就写日志，早于平台写历史、推送，轮到处理时一定写了，不用重试。
 */
export async function findQuoteRef(api, cfg, msgId) {
  const lines = await fetchBotLogs(api, cfg);
  const texts = chatTexts(lines);
  const id = parseQuoteRef(lines, msgId, texts);
  return id ? { id, sticker: parseStickerEvents(lines, texts).find((e) => e.id === id) || null } : null;
}

// ---- 表情包尺寸 ----
// 入站图平台存两份：聊天记录里的 url 是平台上传目录（/uploads/…，不支持缩放）；puppet 日志里的 remoteUrl 在 OSS（支持 x-oss-process）。
// 两份按文件名尾巴「微信图片_<14 位时间戳>.<ext>」对应。harness 收到图时立刻去日志学 OSS 地址，入库时挂缩放参数。

export const isOssUrl = (u) => /\.aliyuncs\.com\//.test(String(u));

/** 给 OSS 地址挂缩放参数（长边 edge、jpg 质量 quality）；已有 x-oss-process 则替换，其它 query 保留。非 OSS 原样返回。 */
export function stickerUrl(url, { edge, quality }) {
  const s = decodedUrl(url);
  if (!isOssUrl(s)) return s;
  const [base, query = ""] = s.split("?");
  const rest = query.split("&").filter((kv) => kv && !kv.startsWith("x-oss-process="));
  return `${base}?${[...rest, `x-oss-process=image/resize,m_lfit,w_${edge},h_${edge}/format,jpg/quality,q_${quality}`].join("&")}`;
}

/** 文件名尾部的「微信图片_<时间戳>.<ext>」，两份副本共有的标识；没有则 null。 */
export function wxImageKey(url) {
  try { return /(微信图片_\d{14}\.\w+)$/.exec(decodeURIComponent(String(url).split(/[?#]/)[0].split("/").pop()))?.[1] || null; }
  catch { return null; }
}

/**
 * 在 puppet 日志里找与 uploads 地址同一张图的 OSS remoteUrl；找不到 null。
 * 键「微信图片_<14 位时间戳>」只精确到秒：同一秒连发几张，日志里同一个键会对上几个不同地址，
 * 这时宁可返回 null（上层存原图，照样能发）也不瞎挑一张——挑错了，「分别存成 A、B、C」就会三个名字存成同一张。
 */
export function matchOssUrl(logLines, uploadsUrl) {
  const key = wxImageKey(uploadsUrl);
  if (!key) return null;
  const hits = new Set();
  for (const line of logLines) {
    const m = /remoteUrl:\s*'([^']+)'/.exec(line);
    if (m && wxImageKey(m[1]) === key) hits.add(decodedUrl(m[1]));
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** 读 puppet 日志（平台只给最后 1000 行）。strict 时接口出错往外抛（表情拉取要知道是没数据还是拉失败了），否则返回空数组。 */
async function fetchBotLogs(api, cfg, { strict = false } = {}) {
  let res;
  try { res = await api.logs(cfg.bot.id); } catch (e) { if (strict) throw e; return []; }
  const raw = Array.isArray(res) ? res : res?.logs ?? res ?? [];
  return Array.isArray(raw) ? raw.map(String) : String(raw).split("\n");
}

/** 入站图的可缩放 OSS 地址。刚收到的图日志可能还没写到，带几次短重试（retries 只给测试改）；失败 null。 */
export async function findOssUrl(api, cfg, url, { retries = OSS_LOOKUP_RETRIES } = {}) {
  if (isOssUrl(url)) return decodedUrl(url);
  if (!wxImageKey(url)) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(OSS_LOOKUP_DELAY_MS);
    const hit = matchOssUrl(await fetchBotLogs(api, cfg), url);
    if (hit) return hit;
  }
  return null;
}

