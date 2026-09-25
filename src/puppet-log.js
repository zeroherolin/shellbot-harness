// 从 puppet 日志里扒平台没给的东西：微信表情（平台不记录）、入站图片的可缩放 OSS 地址（平台只给不能缩放的上传目录地址）。
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
/** puppet 的事件日志行：pm2 前缀「2026-09-25 22:26 +08:00: 」+「22:26:49 INFO event------- 」+ JSON，整行锚定。 */
const EVENT_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}: \d{2}:\d{2}:\d{2} INFO event------- (\{.*\})$/s;

/**
 * 从 puppet 日志行里解析出微信表情：[{ id, convId, isGroup, senderId, ts, name, url, width, height }]，按日志顺序。解析不了的行跳过。
 * 整行必须是 puppet 自己打的那种（pm2 时间前缀 + 时间 + INFO event------- + JSON）：群友发的文字也会出现在日志里，
 * 只按子串找「event------- {」的话，有人把一段伪造的 JSON 当消息发出来就能冒充别人发的表情。
 */
export function parseStickerEvents(lines) {
  const out = [];
  for (const line of lines) {
    const m = EVENT_LINE.exec(line);
    if (!m || !line.includes("<emoji")) continue;
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
  return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'") : "";
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
  let primed = false;
  return async function poll() {
    const events = parseStickerEvents(await fetchBotLogs(getApi(), getCfg(), { strict: true }));
    const fresh = primed ? events.filter((e) => !seen.has(e.id)) : [];
    for (const e of events) seen.add(e.id);
    while (seen.size > STICKER_SEEN_MAX) seen.delete(seen.values().next().value);
    primed = true;
    return fresh;
  };
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

