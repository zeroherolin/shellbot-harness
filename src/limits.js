// 出站节流、静默时段、陈旧判定、群里一轮几张图、长文拆条（都是策略；有状态的出站队列 makeOutbox 在 send.js）。个人微信对发送频率敏感，所以全局排队而不是丢消息。
// 参数全部来自 config.limits，这里不写兜底值。
import { sleep } from "./util.js";

export function makeLimiter(init) {
  let cfg = init;
  let nextSlot = 0;  // 下一个可发送时隙；热更新不重置

  return {
    update(next) { cfg = next; },

    /** 返回 null 表示可发，否则返回原因。 */
    quietGate({ direct }) {
      if (inQuietHours(cfg.quietHours, Date.now()) && !(direct && cfg.quietHours.allowDirect)) return "quiet-hours";
      return null;
    },

    isStale(ts) { return Date.now() - ts > cfg.maxWaitMs; },

    /** 预定下一个时隙并等到它；并发调用各拿递增时隙，按序放行。 */
    async pace() {
      const now = Date.now();
      const slot = Math.max(now, nextSlot);
      nextSlot = slot + cfg.minIntervalMs;
      if (slot > now) await sleep(slot - now);
    },
  };
}

export function inQuietHours(q, now) {
  if (!q.enabled) return false;
  const d = new Date(now);
  const h = d.getHours() + d.getMinutes() / 60;
  const { from, to } = q;  // from > to 表示跨夜
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** 群里这一轮最多发几张图 / 表情（0 = 不限）：平时 groupImagesPerTurn；有人明说要多发时放宽到 groupImagesOnRequest，只放宽、不收紧。 */
export function groupImageCap(limits, askedMany) {
  const base = limits.groupImagesPerTurn, more = limits.groupImagesOnRequest;
  if (!askedMany || base === 0) return base;
  return more === 0 ? 0 : Math.max(base, more);
}

const SPLIT_DELIM = /^[ \t]*-{3,}[ \t]*$/m;  // 模型主动分条的标记：单独一行 ---（提示词里约定），行内的 --- 不算

/**
 * 拆条：先按模型写的分隔行切成几段（像真人分几条发），每段再按长度切（优先换行、再句号）；总数不超过 maxParts、不丢字。
 * 段数超了把多出的并进最后一段；长度切分给每段的配额 = 剩余条数 − 后面还没处理的段数，最后一条不截断。
 */
export function splitText(text, { maxChars, maxParts }) {
  const segs = String(text).split(SPLIT_DELIM).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return [];
  if (segs.length > maxParts) segs.splice(maxParts - 1, segs.length, segs.slice(maxParts - 1).join("\n"));
  const parts = [];
  segs.forEach((seg, i) => {
    const budget = Math.max(1, maxParts - parts.length - (segs.length - 1 - i));
    parts.push(...splitByLength(seg, maxChars, budget));
  });
  return parts;
}

/**
 * 按长度切：约 maxChars 一条，优先在换行处断、其次句末标点（标点正好落在第 maxChars+1 个字也算进这一条，免得下一条以「。」开头），
 * 都没有才硬切（不切开 emoji 的代理对）；最后一条不截断。
 */
function splitByLength(text, maxChars, maxParts) {
  const parts = [];
  let rest = text.trim();
  while (rest) {
    if (rest.length <= maxChars || parts.length === maxParts - 1) { parts.push(rest); break; }
    let end = rest.lastIndexOf("\n", maxChars) + 1;  // 这一条到哪（不含）；换行本身会被 trim 掉
    if (end < maxChars / 2) end = Math.max(...["。", "！", "？", ".", "!", "?"].map((ch) => rest.lastIndexOf(ch, maxChars))) + 1;
    if (end < maxChars / 2) end = /[\uD800-\uDBFF]/.test(rest[maxChars - 1]) ? maxChars - 1 : maxChars;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  return parts.filter(Boolean);
}
