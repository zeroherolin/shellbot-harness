// 出站节流、静默时段、陈旧丢弃、长文拆条。个人微信对发送频率敏感，所以全局排队而不是丢消息。
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

/**
 * 出站队列：push 立即返回，后台按 limiter.pace() 的节奏顺序发；发送失败交给 onError，不抛回调用方。
 * 这样工具循环和会话 lane 不会被「等发送」拖住。drain() 等队列清空，退出前用。
 * persist(jobs) 在队列每次变化时同步调用（可选），调用方落盘、崩溃重启后读回再 push。
 * 等到时隙才出队、落盘：等时隙期间崩溃这条还在盘上；正在发的那条不在 jobs 里，发到一半崩了宁可丢这一条，也不重复发进群。
 * 排队超过 limits.maxWaitMs 的（job.ts 太旧）先丢、交给 onStale，不占时隙：停机很久后续发一批过期的，不能每条白等一个间隔才轮到新回复。
 * hold() / resume()：暂停 / 恢复出队（入队、落盘照常），启动续发时等 OpenClaw 连上用。
 * stop()：退出时 drain 超时后调用，正在发的那条发完就不再出队，剩下的留在盘上给下一个进程续发；之后 push 只落盘不发。
 */
export function makeOutbox({ limiter, send, onError, persist = () => {}, onStale = () => {} }) {
  const queue = [];
  let running = null, inFlight = false, held = false, stopped = false;
  const save = () => { try { persist(queue); } catch {} };  // 落盘失败只是少一层保险，不能影响发送
  const stale = (job) => Number.isFinite(job?.ts) && limiter.isStale(job.ts);
  const run = async () => {
    try {
      while (queue.length && !held && !stopped) {
        if (stale(queue[0])) { const job = queue.shift(); save(); try { onStale(job); } catch {} continue; }
        await limiter.pace();
        if (held || stopped) break;  // 等时隙期间被暂停 / 停止：这条还没出队、还在盘上
        const job = queue.shift();
        save();
        inFlight = true;
        try { await send(job); }
        catch (e) { try { onError(job, e); } catch {} }  // onError 自己炸了也不能带死循环
        inFlight = false;
      }
    } finally { running = null; inFlight = false; }  // 任何意外抛错都要放开，否则 push 以为还在跑、队列永久卡死
  };
  const kick = () => { if (!running && !held && !stopped && queue.length) running = run(); };
  return {
    push(job) {
      queue.push(job);
      save();
      kick();
    },
    hold() { held = true; },
    resume() { held = false; kick(); },
    held: () => held,
    stop() { stopped = true; save(); },
    /** 立刻按当前队列落一次盘（换了落盘位置时用）。 */
    save,
    size: () => queue.length + (inFlight ? 1 : 0),
    drain: () => running || Promise.resolve(),
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

function splitByLength(text, maxChars, maxParts) {
  const parts = [];
  let rest = text.trim();
  while (rest) {
    if (rest.length <= maxChars || parts.length === maxParts - 1) { parts.push(rest); break; }
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars / 2) cut = Math.max(...["。", "！", "？", ".", "!", "?"].map((ch) => rest.lastIndexOf(ch, maxChars)));
    if (cut < maxChars / 2) cut = maxChars - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return parts.filter(Boolean);
}
