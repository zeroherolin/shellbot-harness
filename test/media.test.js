import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMedia } from "../src/media.js";

/** 假依赖：下载都成功、上传落在 uploads 里。图库里有一张 OSS 地址的表情（启动时它的主机会被记成「已托管」）。 */
function setup() {
  const uploads = [];
  const deps = {
    cfg: { host: "https://plat.example", images: { downloadTimeoutMs: 1000, maxBytes: 1e6, downloadRetries: 0, rehost: true } },
    api: { upload: async ({ filename }) => { uploads.push(filename); return `https://files.example/uploads/1/chat/${filename}`; } },
    bot: { apiSecret: "s" },
    mem: { stickers: () => [{ name: "旧", url: "https://b.oss-cn-guangzhou.aliyuncs.com/wecdn/2026-09-22/a.png" }] },
    log: { info() {}, warn() {} },
  };
  const media = makeMedia(() => deps, { fetchImageData: async () => ({ mediaType: "image/jpeg", buffer: Buffer.from("x") }), checkStickers: async () => [] });
  return { media, uploads };
}

test("keep（存进图库）：OSS 地址哪怕主机记成了已托管也搬到平台（实测 wecdn/<日期>/ 的图一周左右就 404）；平台自己的地址原样；host（发图）照旧不搬 OSS", async () => {
  const { media, uploads } = setup();
  const oss = "https://b.oss-cn-guangzhou.aliyuncs.com/wecdn/2026-09-28/c.png?x-oss-process=image/resize,m_lfit,w_240,h_240/format,jpg/quality,q_85";
  assert.equal(await media.host(oss), oss);  // 发图：一周内拉得到，不用搬
  assert.equal(uploads.length, 0);
  assert.match(await media.keep(oss), /^https:\/\/files\.example\/uploads\/1\/chat\/harness_\d+\.jpg$/);
  assert.equal(uploads.length, 1);
  assert.equal(await media.keep("https://plat.example/x.png"), "https://plat.example/x.png");  // 平台域名
  assert.equal(await media.keep("https://files.example/uploads/1/chat/y.png"), "https://files.example/uploads/1/chat/y.png");  // 平台上传目录
  assert.equal(uploads.length, 1);
});
