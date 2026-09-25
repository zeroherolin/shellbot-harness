// 测试共用的小工具：临时目录（这个测试文件跑完自动删）、替换全局 fetch、构造响应、轮询等待。不是测试文件，npm test 只跑 *.test.js。
import { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** 建一个临时目录，这个测试文件跑完自动删：harness 用例会往里写上下文、日志，不删的话每跑一次就在系统临时目录里留一堆。 */
export function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 把全局 fetch 换成 impl 跑 fn，跑完（哪怕抛错、超时）都换回来，桩不会漏给后面的用例。 */
export async function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

export const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
export const resp = (status, body, headers = {}) => new Response(body, { status, headers });

/** 轮询到 pred 为真；ms 内等不到就抛错。 */
export async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}
