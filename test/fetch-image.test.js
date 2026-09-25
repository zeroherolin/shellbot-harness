import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImageType, fetchImageData, checkStickers, isPrivateAddress, VISION_MEDIA_TYPES } from "../src/fetch-image.js";
import { withFetch, resp } from "./helpers.js";
const IMG = { timeoutMs: 15000, maxBytes: 5000000, retries: 3, allowPrivate: true };  // mock fetch 的测试不做 DNS 校验

test("图片类型按魔数嗅探", () => {
  const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);
  assert.equal(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47])), "image/png");
  assert.equal(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(pad([0x47, 0x49, 0x46, 0x38])), "image/gif");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)])), "image/webp");
  assert.equal(sniffImageType(pad([0x42, 0x4d])), "image/bmp");
  assert.equal(sniffImageType(Buffer.from("hello world!!")), null);
  assert.equal(sniffImageType(Buffer.alloc(3)), null);
});

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);

test("checkStickers：404 / 超时 / 非图片算失效，正常的不报；只看响应头", async () => {
  const list = [{ name: "好的", url: "https://x/a.png" }, { name: "没了", url: "https://x/b.png" }, { name: "网页", url: "https://x/c" }, { name: "慢", url: "https://x/d.png" }];
  const dead = await withFetch(async (url) => {
    if (url.endsWith("a.png")) return resp(200, png, { "content-type": "image/png" });
    if (url.endsWith("b.png")) return resp(404, "");
    if (url.endsWith("/c")) return resp(200, "<html>", { "content-type": "text/html" });
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  }, () => checkStickers(list, { timeoutMs: 1000, allowPrivate: true, retryDelayMs: 0 }));
  assert.deepEqual(dead.sort((a, b) => a.name.localeCompare(b.name)), [{ name: "慢", reason: "超时" }, { name: "没了", reason: "HTTP 404" }, { name: "网页", reason: "不是图片" }].sort((a, b) => a.name.localeCompare(b.name)));
});

test("checkStickers：连不上 / 5xx 先重试，好了就不算失效（实测启动时一张 fetch failed 被报成失效、劝人删掉）；4xx、不是图片不重试；一直不通才报", async () => {
  const calls = {};
  const dead = await withFetch(async (url) => {
    const n = (calls[url] = (calls[url] || 0) + 1);
    if (url.endsWith("flaky.png") && n === 1) throw new TypeError("fetch failed");
    if (url.endsWith("busy.png") && n === 1) return resp(503, "");
    if (url.endsWith("down.png")) throw new TypeError("fetch failed");
    if (url.endsWith("gone.png")) return resp(404, "");
    return resp(200, png, { "content-type": "image/png" });
  }, () => checkStickers(["flaky", "busy", "down", "gone"].map((n) => ({ name: n, url: `https://x/${n}.png` })), { timeoutMs: 1000, allowPrivate: true, retries: 2, retryDelayMs: 0 }));
  assert.deepEqual(dead.sort((a, b) => a.name.localeCompare(b.name)), [{ name: "down", reason: "fetch failed" }, { name: "gone", reason: "HTTP 404" }]);
  assert.deepEqual(calls, { "https://x/flaky.png": 2, "https://x/busy.png": 2, "https://x/down.png": 3, "https://x/gone.png": 1 });
});

test("fetchImageData：魔数优先于错误的 content-type；未就绪重试", async () => {
  let calls = 0;
  const d = await withFetch(async () => (++calls === 1 ? resp(404, "") : resp(200, png, { "content-type": "application/octet-stream" })), () => fetchImageData("https://x/a", { ...IMG, retries: 2 }));
  assert.equal(calls, 2);
  assert.equal(d.mediaType, "image/png");
  assert.equal(d.bytes, png.length);
});

test("fetchImageData：过大与非图片不重试", async () => {
  let calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return resp(200, Buffer.alloc(20)); }, () => fetchImageData("https://x/a", { ...IMG, maxBytes: 10 })), /过大/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withFetch(async () => { calls++; return resp(200, Buffer.from("not an image at all"), { "content-type": "text/plain" }); }, () => fetchImageData("https://x/a", IMG)), /不是图片/);
  assert.equal(calls, 1);
});

test("fetchImageData：返回原始 buffer 供上传复用", async () => {
  const d = await withFetch(async () => resp(200, png, { "content-type": "image/png" }), () => fetchImageData("https://x/a", IMG));
  assert.ok(Buffer.isBuffer(d.buffer) && d.buffer.equals(png));
});

test("isPrivateAddress：回环 / 私网 / 链路本地 / CGNAT / 组播 / IPv6 本地与映射形式都算内网；公网不算", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "64:ff9b::10.0.0.1", "not-an-ip"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:808:808"]) assert.equal(isPrivateAddress(ip), false, ip);
  for (const ip of ["198.18.0.5", "198.19.255.1"]) assert.equal(isPrivateAddress(ip), false, `${ip}：代理 fake-ip 段不能算内网，否则开着代理一张图都下不了`);
});

test("fetchImageData：不拉内网 / 本机地址，跳转到内网也拦（每跳都校验），不支持的协议直接拒；一律不重试", async () => {
  const opts = { timeoutMs: 1000, maxBytes: 5000000, retries: 3 };
  let calls = 0;
  const f = async () => { calls++; return resp(200, png, { "content-type": "image/png" }); };
  for (const u of ["http://127.0.0.1:8080/a.png", "http://[::ffff:127.0.0.1]/a.png", "http://10.0.0.5/a.png", "http://169.254.169.254/latest/meta-data"]) {
    await assert.rejects(withFetch(f, () => fetchImageData(u, opts)), /内网/, u);
  }
  await assert.rejects(withFetch(f, () => fetchImageData("file:///etc/passwd", opts)), /http\(s\)/);
  assert.equal(calls, 0);
  const hops = [];
  await assert.rejects(withFetch(async (u, init) => { hops.push([u, init.redirect]); return resp(302, null, { location: "http://127.0.0.1/x.png" }); }, () => fetchImageData("http://93.184.216.34/a.png", opts)), /内网/);
  assert.deepEqual(hops, [["http://93.184.216.34/a.png", "manual"]]);
  assert.equal((await withFetch(f, () => fetchImageData("http://10.0.0.5/a.png", { ...opts, trustedHosts: ["10.0.0.5"] }))).mediaType, "image/png");  // 自建平台在内网：平台域名放行
});

test("fetchImageData：跟公网跳转、超过上限就停；content-length 超限不读正文；错误页不当图片（哪怕 url 是 .jpg）", async () => {
  const d = await withFetch(async (u) => (u.endsWith("/a") ? resp(301, null, { location: "/b.png" }) : resp(200, png)), () => fetchImageData("https://x/a", IMG));
  assert.equal(d.mediaType, "image/png");
  let n = 0;
  await assert.rejects(withFetch(async () => { n++; return resp(302, null, { location: `/r${n}` }); }, () => fetchImageData("https://x/a", IMG)), /跳转超过/);
  assert.equal(n, 4);  // 首次 + 3 跳，然后放弃、不重试
  await assert.rejects(withFetch(async () => resp(200, png, { "content-length": "99999999" }), () => fetchImageData("https://x/a", IMG)), /过大/);
  await assert.rejects(withFetch(async () => resp(200, "<html>登录</html>", { "content-type": "text/html; charset=utf-8" }), () => fetchImageData("https://x/a.jpg", IMG)), /不是图片（text\/html）/);
  assert.equal((await withFetch(async (u) => (u.endsWith("/a") ? resp(302, null, { location: "/pic.gif" }) : resp(200, Buffer.alloc(20))), () => fetchImageData("https://x/a", IMG))).mediaType, "image/gif");  // 扩展名兜底看跳转后的地址
});

test("VISION_MEDIA_TYPES：模型只看 jpeg / png / gif / webp，bmp 不在内", () => {
  assert.deepEqual([...VISION_MEDIA_TYPES].sort(), ["image/gif", "image/jpeg", "image/png", "image/webp"]);
  assert.equal(VISION_MEDIA_TYPES.has("image/bmp"), false);
});

test("checkStickers：和下载图片同一套地址校验，内网地址直接算失效、不发请求", async () => {
  let calls = 0;
  const dead = await withFetch(async () => { calls++; return resp(200, png, { "content-type": "image/png" }); }, () => checkStickers([{ name: "内网", url: "http://192.168.1.2/a.png" }], { timeoutMs: 1000 }));
  assert.equal(calls, 0);
  assert.equal(dead.length, 1);
  assert.match(dead[0].reason, /内网/);
});
