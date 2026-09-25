// 发送：出站队列（节流、落盘续发）+ 通道选择（OpenClaw 真 @ / HTTP 回退）。harness 建一个实例，所有出站都经 deliver。
// 依赖都是「活」的：get() 取当前的 { cfg, api, mem, log, ws, oc }，热更新换了配置 / 凭证 / workspace / 连接也跟着换。
import fs from "node:fs";
import path from "node:path";
import { openclawOutbound, platformSafeText } from "./platform.js";
import { sendTarget } from "./api.js";
import { mentionPrefix } from "./gate.js";
import { makeOutbox } from "./limits.js";
import { writeFileAtomic } from "./util.js";

const OUTBOX_FILE = "outbox.json";  // 出站队列落盘文件（workspace 下），崩溃重启后续发

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
