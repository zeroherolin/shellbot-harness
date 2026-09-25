// 发送：出站队列（makeOutbox：节流、落盘续发）+ 通道选择（OpenClaw 真 @ / HTTP 回退）。harness 建一个实例，所有出站都经 deliver。
// 依赖都是「活」的：get() 取当前的 { cfg, api, mem, log, ws, oc }，热更新换了配置 / 凭证 / workspace / 连接也跟着换。
import fs from "node:fs";
import path from "node:path";
import { openclawOutbound, platformSafeText } from "./platform.js";
import { sendTarget } from "./api.js";
import { mentionPrefix } from "./gate.js";
import { writeFileAtomic } from "./util.js";

const OUTBOX_FILE = "outbox.json";  // 出站队列落盘文件（workspace 下），崩溃重启后续发

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

/**
 * 文字（群和私聊）优先走 OpenClaw：能真 @、且不经平台 HTTP 那套文本过滤（platformSafeText）；OpenClaw 不写平台历史，自己记一份供翻历史合并。
 * 图片只有 HTTP type:10 能发（外站图由调用方在入队前搬到平台，media.rehost）。OpenClaw 肯定没发出去才回退 HTTP；
 * 结果未知（PUBACK 超时 / 断线）不重发，宁可丢一条也不重复进群。队列每次变化同步落盘（原子写），崩溃 / 被 kill 后下次启动续发。
 * 每个任务带本轮的日志器（log 字段，不落盘）：投递发生在出队之后，靠它把 sent 事件挂回那一轮。
 */
export function makeSender(get, limiter) {
  const file = () => path.join(get().ws, OUTBOX_FILE);
  let persistFailed = false;  // 落盘失败只报第一次，恢复后再失败再报
  const jobLog = (job) => job.log || get().log;
  const sentEvent = (job, t0, extra) => jobLog(job).event("sent", {
    conv: job.conv.id, convName: job.conv.name, turn: job.turn, kind: job.messages.every((x) => x.type === 1) ? "文字" : "图片",
    count: job.messages.length, elapsedMs: Date.now() - t0, waitMs: t0 - job.ts, ...extra,
  });
  const staleEvent = (job) => jobLog(job).event("dropped", { conv: job.conv?.id, convName: job.conv?.name, turn: job.turn, reason: "stale-outbox" });

  async function send(job) {
    const { cfg, api, mem, oc } = get();
    const { conv, messages, mentions, ts } = job;
    const jlog = jobLog(job);
    if (limiter.isStale(ts)) return staleEvent(job);  // 出队前查过一次；等时隙那一下又过了线的
    const t0 = Date.now();
    const textOnly = messages.every((x) => x.type === 1);
    if (textOnly && oc?.connected()) {
      let outcome = "sent";  // sent | uncertain | failed
      try { await oc.publish(openclawOutbound(conv, messages, mentions.map((m) => m.wxid))); }
      catch (e) {
        outcome = e.uncertain ? "uncertain" : "failed";
        if (outcome === "uncertain") jlog.error(`OpenClaw 发送结果未知，不重发以免重复进群：${e.message}`);
        else jlog.warn(`OpenClaw 发送失败，回退 HTTP：${e.message}`);
      }
      if (outcome !== "failed") {
        // 发出去（或多半发出去）的记进发送日志：平台不记这条通道的历史。写日志失败只记 warn，绝不因此回退重发
        try { messages.forEach((m, i) => mem.appendSent(conv.id, { ts: Date.now(), text: (i ? "" : mentionPrefix(mentions)) + m.content })); }
        catch (e) { jlog.warn(`发送日志写入失败：${e.message}`); }
        sentEvent(job, t0, { channel: "openclaw", outcome });
        return;
      }
    }
    const out = textOnly
      ? messages.map((m, i) => ({ ...m, content: platformSafeText((i ? "" : mentionPrefix(mentions)) + m.content, { isGroup: conv.isGroup }) }))
      : messages;
    try { await api.send(cfg.bot.id, sendTarget(conv), out); }
    catch (e) { sentEvent(job, t0, { channel: "http", outcome: "failed", error: e.message }); throw e; }  // 失败也落事件：这一轮的证据链不能断在最后一步
    sentEvent(job, t0, { channel: "http", outcome: "sent" });
  }

  const outbox = makeOutbox({
    limiter,
    send,
    onError: (job, e) => jobLog(job).error(`发送失败（${job.conv?.name || job.conv?.id}）：${e.message}`),
    onStale: staleEvent,
    persist: (jobs) => {
      try { writeFileAtomic(file(), JSON.stringify(jobs.map(({ log: _drop, ...rest }) => rest))); persistFailed = false; }
      catch (e) { if (!persistFailed) get().log.warn(`出站队列落盘失败（崩溃后这些消息不会续发）：${e.message}`); persistFailed = true; }
    },
  });

  // 往没登记过的群（从没在那个群收到过消息）发文字：机器人可能根本不在群里，而 OpenClaw 没有投递回执、发了也不报错。每个群提醒一次，照常发
  const unseenRooms = new Set();
  function deliver(conv, messages, mentions = [], meta = {}) {
    if (conv.isGroup && messages.some((m) => m.type === 1) && !unseenRooms.has(conv.id) && !(conv.id in get().mem.rooms())) {
      unseenRooms.add(conv.id);
      (meta.log || get().log).warn(`往群 ${conv.name || conv.id} 发文字，但没在这个群收到过消息，机器人可能不在群里；OpenClaw 没有投递回执，发不到也不会报错`);
    }
    outbox.push({ conv, messages, mentions, ts: Date.now(), ...meta });
  }

  const validJob = (j) => !!(j && j.conv?.id && Number.isFinite(j.ts) && Array.isArray(j.messages) && j.messages.length
    && j.messages.every((m) => m && typeof m.type === "number") && Array.isArray(j.mentions ?? []));

  /**
   * 取走上次没发完的：把 outbox.json 改名「取走」再读（rename 原子，读一半崩了也不会两次各发一遍）。
   * 读坏了（半截 / 手改坏）和登记表一样改名留底并告警，别悄悄删掉——里面是没发出去的回复。
   */
  function take() {
    const taken = `${file()}.restoring`;
    try { fs.renameSync(file(), taken); } catch { return []; }
    let jobs = null;
    try { jobs = JSON.parse(fs.readFileSync(taken, "utf8")); } catch {}
    if (Array.isArray(jobs)) { try { fs.unlinkSync(taken); } catch {} return jobs; }
    const bak = `${file()}.corrupt-${Date.now()}`;
    try { fs.renameSync(taken, bak); get().log.warn(`出站队列文件读不出来，已改名留底：${bak}，这批没发出去的回复不续发`); } catch {}
    return [];
  }
  /** 积压重新入队（入队即落盘），返回有效条数。结构不对的跳过；已经过了 limits.maxWaitMs 的直接丢（记 dropped），不算「续发」。 */
  function restore(jobs) {
    if (!jobs.length) return 0;
    const good = jobs.filter(validJob);
    const fresh = good.filter((j) => !limiter.isStale(j.ts));
    for (const j of good) if (!fresh.includes(j)) staleEvent(j);
    const notes = [good.length < jobs.length ? `${jobs.length - good.length} 条结构不对已跳过` : "", fresh.length < good.length ? `${good.length - fresh.length} 条超过 limits.maxWaitMs 已丢弃` : ""].filter(Boolean);
    get().log.info(`续发上次没发完的出站消息 ${fresh.length} 条${notes.length ? `（${notes.join("，")}）` : ""}`);
    for (const { log: _drop, ...job } of fresh) outbox.push({ ...job, mentions: job.mentions || [] });
    return fresh.length;
  }

  /** 换 workspace 时：新 workspace 里有别的进程留下的积压就接着发；队列写到新文件，旧的删掉（留着就是一份过时快照，下次用旧 workspace 启动会重复发）。 */
  function moveTo(oldWs) {
    restore(take());
    outbox.save();
    try { fs.unlinkSync(path.join(oldWs, OUTBOX_FILE)); } catch {}
  }

  return { deliver, take, restore, moveTo, outbox };
}
