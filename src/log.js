// 日志：控制台一行摘要（时间 + 彩色标签 + 内容，左栏对齐），每日 JSONL 落全量。
// 排查「这一轮到底发生了什么」只需要这个目录：入站、模型、工具、投递、丢弃都落成结构化事件，
// inbound 带消息 id，之后这一轮的事件都带 turn（最后一条触发消息的 id）与 conv，可 grep 串起一整轮。
import fs from "node:fs";
import path from "node:path";
import { fmtClock, localDate } from "./util.js";

const tty = process.stdout.isTTY;  // 重定向到文件时不上色
const paint = (code) => (tty ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s);
const c = {
  dim: paint(2), bold: paint(1), red: paint(31), yellow: paint(33), green: paint(32),
  cyan: paint(36), magenta: paint(35), gray: paint(90), blue: paint(34),
};
const TAG = {
  inbound: c.cyan, outbound: c.green, sent: c.green, agent: c.dim, tool: c.magenta,
  dropped: c.gray, info: c.blue, warn: c.yellow, error: c.red,
};
const TAG_WIDTH = 8;
const CLIP = { text: 60, error: 40, input: 50, misc: 80 };  // 控制台摘要各字段截断长度
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** 带时区偏移的本地 ISO 时间（2026-09-25T02:47:41.585+08:00）：和控制台、文件名同一个时区，Date 照样能解析。 */
export function localIso(d = new Date()) {
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  return `${localDate(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${off < 0 ? "-" : "+"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

/**
 * 文件名、跨天判定、ts 都按本地时区（进程 TZ，即 config.timezone）：以前用 UTC，北京时间凌晨的事落在前一天的文件里。
 * now 可选，测试注入时钟用（返回毫秒）。
 */
export function makeLog(dir, { keepDays, now = Date.now } = {}) {
  if (!(keepDays > 0)) throw new Error("makeLog 缺少 keepDays（来自 config.logs.keepDays）");
  fs.mkdirSync(dir, { recursive: true });
  const today = () => localDate(new Date(now()));
  /**
   * 日志按天分文件、只增不减，久了很占地方：启动时和跨天时各清一次超期的。
   * 返回要播报的消息（清理了几条 / 哪个文件删不动）——调用方负责记（控制台 + JSONL），免得清理悄悄发生或悄悄失败。
   * 单个文件出错不中断整轮：权限、并发删除都只影响那一个。
   */
  const pruneOnce = () => {
    const notes = [];
    const cutoff = now() - keepDays * DAY_MS;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return [`读取日志目录失败：${e.message}`]; }
    let n = 0;
    for (const f of names) {
      if (!LOG_NAME_RE.test(f)) continue;
      try {
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); n++; }
      } catch (e) { notes.push(`清理旧日志 ${f} 失败：${e.message}`); }
    }
    if (n) notes.push(`清理 ${n} 个超过 ${keepDays} 天的日志文件`);
    return notes;
  };
  let lastPruned = today();
  const startNotes = pruneOnce();
  // 同步追加：事件量小，换退出前不丢最后几行
  const append = (d, row) => {
    try { fs.appendFileSync(path.join(dir, `${localDate(d)}.jsonl`), JSON.stringify({ ts: localIso(d), ...row }) + "\n"); } catch {}
  };
  const toFile = (row) => {
    const d = new Date(now());
    const rolled = localDate(d) !== lastPruned;
    if (rolled) lastPruned = localDate(d);  // 先改，下面把清理结果写进日志时就不会再判成跨天
    append(d, row);
    // 跨天清理的结果也落 JSONL（写进新一天的文件），排查时只看日志目录就够
    if (rolled) for (const note of pruneOnce()) { emit("info", note); append(d, { level: "INFO", msg: note }); }
  };
  const emit = (tag, body) => console.log(`${c.dim(fmtClock(new Date(now())))} ${(TAG[tag] || ((s) => s))(tag.padEnd(TAG_WIDTH))} ${body}`);
  const write = (level, msg, extra) => { emit(level, msg); toFile({ level: level.toUpperCase(), msg, ...extra }); };

  const scoped = (fields) => ({
    info: (m, e) => base.info(m, { ...fields, ...e }),
    warn: (m, e) => base.warn(m, { ...fields, ...e }),
    error: (m, e) => base.error(m, { ...fields, ...e }),
    event: (name, data = {}) => base.event(name, { ...fields, ...data }),
    with: (extra = {}) => scoped({ ...fields, ...extra }),
  });
  const base = {
    info: (m, extra) => write("info", m, extra),
    warn: (m, extra) => write("warn", m, extra),
    error: (m, extra) => write("error", m, extra),
    /** 结构化事件：控制台打摘要，JSONL 落全量。 */
    event: (name, data = {}) => { emit(name, summary(name, data)); toFile({ level: "EVENT", event: name, ...data }); },
    /**
     * 派生一个带上固定字段的日志器：该会话 / 该轮里的工具、告警、投递都自动带上 conv / convName / turn，
     * 多会话并发时控制台与 JSONL 都不再混成一团、也能按 turn 串起一轮。
     */
    with: (fields = {}) => scoped(fields),
  };
  for (const note of startNotes) base.info(note);
  return base;
}

const clip = (s, n = CLIP.text) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const ms2 = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");

/** 控制台摘要。JSONL 里字段是全的，这里只说人一眼要看的那几件：谁触发、看了几张图、用了多久、结果是什么。 */
function summary(name, d) {
  const conv = c.bold(d.convName || d.conv || "");
  switch (name) {
    case "inbound": {
      const body = d.type && d.type !== "文字" ? `[${d.type}]${d.text ? ` ${clip(d.text)}` : ""}` : clip(d.text);
      return `${conv}  ${d.name}: ${body}  ${c.dim(`${d.verdict}/${d.reason}`)}`;
    }
    case "agent": {
      const meta = `${d.usage ? `${d.usage.input}→${d.usage.output}tok · ` : ""}${ms2(d.ms)}${d.turns > 1 ? ` · ${d.turns}轮` : ""}`;
      const sent = d.toolSends ? `工具已发 ${d.toolSends} 条 · ` : "";
      const out = d.noReply ? (d.toolSends ? "文字 NO_REPLY" : "不回复(NO_REPLY)") : d.failed ? "没答出来" : `${d.textLen}字`;
      const bits = [];
      if (d.images) bits.push(d.visionDropped ? "看图被拒" : `看图 ${d.images}${d.imageSource ? `(${d.imageSource})` : ""}${d.imageEncoding === "url" ? " 仅链接" : ""}`);
      if (d.avatar) bits.push("头像");
      const imgs = bits.length ? `[${bits.join("+")}] ` : "";
      return `${conv}  ${[d.trigger, d.reason].filter(Boolean).join(" ")} · ${sent}${imgs}${out}  ${c.dim(meta)}`;
    }
    case "outbound": {
      const at = d.mentions?.length ? ` · @${d.mentions.join(" @")}` : "";
      return `${conv}  → ${clip(d.text)}  ${c.dim(`${d.parts}条${d.origin === "say" ? " · say" : ""}${at}`)}`;
    }
    case "sent": {
      const where = d.channel === "http" ? `HTTP ${d.kind}` : d.channel === "openclaw" ? `OpenClaw ${d.kind}` : d.kind || "";
      const tail = d.outcome === "uncertain" ? c.yellow(" · 结果未知，不重发") : d.outcome === "failed" ? c.red(` · 失败：${clip(d.error, CLIP.error)}`) : "";
      return `${conv}  ${d.outcome === "failed" ? "✗" : "✓"} ${where} ${d.count} 条  ${c.dim(ms2(d.elapsedMs))}${tail}`;
    }
    case "tool":
      return `${d.convName ? `${c.bold(d.convName)}  ` : ""}${d.tool} ${d.ok ? "ok" : c.red("err: " + clip(d.error, CLIP.error))}`
        + (d.ms !== undefined ? c.dim(` · ${ms2(d.ms)}`) : "")
        + (d.outLen !== undefined ? c.dim(` · 返回 ${d.outLen} 字`) : "")
        + (d.input ? c.dim(" · " + clip(JSON.stringify(d.input), CLIP.input)) : "");
    case "dropped":
      return `${conv}  ${c.dim(d.reason)}`;
    default:
      return c.dim(clip(JSON.stringify(d), CLIP.misc));
  }
}
