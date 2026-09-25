// 跨模块共用的小工具。
import fs from "node:fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ERR_CLIP = 200;  // 错误 / 载荷摘要截断长度
export const CONFIG_POLL_MS = 1000;   // --hot 下轮询配置文件的间隔（worker 热更新与监督进程共用；轮询不怕编辑器改名式保存）
export const HISTORY_PAGE_MAX = 500;  // 平台历史单页最多取这么多（平台不设上限，太大拖慢接口）；config 校验 history.maxCount / groups.warmupHistory 也按它

const pad = (n) => String(n).padStart(2, "0");
/** MM-DD HH:mm，给模型看的时间。 */
export const fmtTime = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** HH:mm:ss，控制台用。 */
export const fmtClock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
/** 本地日期 YYYY-MM-DD（按 process.env.TZ，即 config.timezone）。日志文件名、备忘日期都用它；toISOString 是 UTC，北京时间 0~8 点会落到前一天。 */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 文件名用的本地时间戳，到毫秒：20260925-024741-585。坏文件留底、配置备份都用它。 */
export const fileStamp = (d = new Date()) => `${localDate(d).replace(/-/g, "")}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
/** 普通对象（不是 null、不是数组）。 */
export const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/** 按长度截断，不把 emoji 这类代理对切成半个：孤立代理进了请求 JSON，Anthropic 会整条 400。 */
export function safeSlice(s, n) {
  const str = String(s ?? "");
  if (str.length <= n) return str;
  const cut = str.slice(0, Math.max(0, n));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** 原子写：先写同目录临时文件再 rename。写到一半被 kill / 断电，原文件要么是旧的完整版、要么是新的完整版，不会半截。 */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

/** 平台时间戳秒 / 毫秒都兼容，统一成毫秒；非法用当前时间。 */
export function toMillis(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

/** 平台的布尔字段有时是字符串 "True"。 */
export const isTrue = (v) => v === true || v === "True";

/** 是不是图片消息。兼容上下文消息（isImage 布尔）和平台聊天记录。 */
export function isImageMsg(m) {
  return !!m?.url && (isTrue(m.isImage) || /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i.test(String(m.url)));
}

/** 平台偶尔拿 wxid / 群 id 顶替昵称，那不算名字。 */
export const isNickname = (s) => !!s && !/^wxid_|@chatroom$/.test(s);

/** 机器人自己发出的消息记进上下文用的条目：mine 标记让 gate 与 prompt 都认得出「这是我」。 */
let ownSeq = 0;
export const ownEntry = (bot, patch) => {
  const now = Date.now();
  return { id: `bot-${now}-${ownSeq++}`, ts: now, from: bot.robotId || "bot", name: bot.name, mine: true, ...patch };
};

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const stripSlash = (s) => String(s).replace(/\/+$/, "");
/** 压成一行：连续空白变一个空格。 */
export const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
/** 去掉全部空白，用于名字比对。 */
export const noSpace = (s) => String(s || "").replace(/\s+/g, "");

/**
 * 聊天内容里伪造的框定标签转全角失效。正文、昵称、群名、备忘，凡是成员能改的字段进 prompt 前都要过一遍。
 * 标签里夹空格（</conversation >、< /trigger>）也算：尖括号后面跟着这几个名字、到 > 为止，两个尖括号都换成全角。
 */
export const noTags = (s) => String(s || "").replace(/<(\s*\/?\s*)(conversation|notes|trigger|members)\b([^<>]*)>/gi, "＜$1$2$3＞");

/** 按点路径取值。 */
export const getPath = (obj, p) => p.split(".").reduce((x, k) => x?.[k], obj);

/** 出站给平台的 url 必须是原文：平台会再编码一次，传已编码的会变双重编码，微信收到 0B 文件。解不开就原样返回。 */
export function decodedUrl(url) {
  const s = String(url || "").trim();
  try { return decodeURI(s); } catch { return s; }
}

/** 自己 fetch 用的 url：只编码非 ASCII 与空格，已有的 %XX（含 %2F 这类保留字转义、签名参数）原样保留，不双重编码。 */
export function encodedUrl(url) {
  const s = String(url || "").trim();
  try { return encodeURI(s).replace(/%25([0-9A-Fa-f]{2})/g, "%$1"); } catch { return s; }
}

/** 带 fatal 标记的错误：retry 见到就不再重试。 */
export const fatal = (message) => Object.assign(new Error(message), { fatal: true });

/**
 * 有限重试：fn 抛错且不是 fatal 就等 delay(第几次, 这次的错误) 再试，最多 retries 次。
 * 网络错误、5xx、空响应这类瞬时故障都该重试；4xx、业务拒绝、内容不合格用 fatal() 抛，立即放弃。
 * onRetry(错误, 第几次重试) 可选：调用方用来记「重试了但最后成功」这类日志——只看最终结果会漏掉这些抖动。
 */
export async function retry(fn, { retries, delay, onRetry }) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(attempt); }
    catch (e) {
      if (e.fatal || attempt >= retries) throw e;
      try { onRetry?.(e, attempt + 1); } catch {}
      await sleep(delay(attempt + 1, e));
    }
  }
}
