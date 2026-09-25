// 入站流水线的三个小件：去重、防抖合并、每会话串行。纯内存，便于单测。

/** 按消息 id 去重，保留最近 max 个。seen(id) 返回是否已见过并登记。 */
export function makeDedupe(max) {
  const set = new Set();
  const order = [];
  const trim = () => { while (order.length > max) set.delete(order.shift()); };
  return {
    seen(id) {
      if (set.has(id)) return true;
      set.add(id); order.push(id);
      trim();
      return false;
    },
  };
}

/** 同 key 的连发在 delayMs 内合并成一批，静默后交给 onFlush(key, items)。flush() 不等窗口、把还在等的立刻全交出去（退出前用）。 */
export function makeDebouncer(onFlush) {
  const pending = new Map();
  return {
    push(key, item, delayMs) {
      let p = pending.get(key);
      if (!p) pending.set(key, (p = { items: [], timer: null }));
      p.items.push(item);
      clearTimeout(p.timer);
      p.timer = setTimeout(() => { pending.delete(key); onFlush(key, p.items); }, delayMs);
    },
    flush() {
      for (const [key, p] of pending) { clearTimeout(p.timer); pending.delete(key); onFlush(key, p.items); }
    },
    size: () => pending.size,
  };
}

/** 每个 key 一条串行 lane：同 key 依次执行，不同 key 并行；出错交给 onError，不阻塞后续。idle() 等所有 lane 都跑完（含等待期间新排进来的）。 */
export function makeLanes(onError) {
  const lanes = new Map();
  return {
    enqueue(key, fn) {
      const prev = lanes.get(key) || Promise.resolve();
      // onError 自己炸了也吞掉：否则这条 lane 的 Promise 变成拒绝，后面排进来的 fn 会被 then 直接跳过
      const next = prev.then(fn).catch((e) => { try { onError(key, e); } catch {} });
      lanes.set(key, next);
      next.finally(() => { if (lanes.get(key) === next) lanes.delete(key); });  // 空闲即清
      return next;
    },
    async idle() {
      while (lanes.size) await Promise.all([...lanes.values()]);
    },
    size: () => lanes.size,
  };
}
