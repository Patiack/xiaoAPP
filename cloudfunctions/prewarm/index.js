// cloudfunctions/prewarm/index.js —— 热搜解读预热（定时触发器）
//
// 作用：
//   1) 每 10 分钟取一次实时热搜，为 Top 20 中尚未生成解读的条目预生成 AI 视点
//   2) 每次最多生成 4 条（并发 4），一轮总耗时约等于单次大模型调用；未完成的条目下一轮继续
//   3) 每小时顺带清理 7 天前的热搜归档、30 天前的解读缓存与用量记录
//
// 为什么不在列表请求里同步生成：热搜刷新频繁，全量生成既慢又贵；
// 「Top 20 预热 + 详情页按需兜底」能保证日常打开秒出，同时把费用压到最低。
//
// ⚠️ 请在云开发控制台把本函数超时时间调到 60 秒。
const cloud = require('wx-server-sdk');
// 云函数端 SDK 默认 15s 超时；interpret 内部的大模型调用最长约 40s，
// 因此必须把调用其它云函数的 SDK 超时调高，否则预热会在 15s 被中断。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 45000 });
const db = cloud.database();
const _ = db.command;

const NEWS_CACHE = 'news_cache';
const INTERP_CACHE = 'interpret_cache';
const TOP_N = 20;
const BATCH = 4;
const CONCURRENCY = 4;   // 与 BATCH 相同：4 条并行，墙钟耗时≈单次 LLM 调用，避免超出 60s

function compactDate(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

// 并发受限的 map
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { error: String(e.message || e) }; }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function cleanup() {
  const now = Date.now();
  const archiveCutoff = compactDate(now - 7 * 86400000);
  const cacheCutoff = now - 30 * 86400000;

  try {
    const res = await db.collection(NEWS_CACHE)
      .where({ type: 'hot_archive', date: _.lt(archiveCutoff) })
      .remove();
    if (res && res.stats && res.stats.removed) {
      console.log('清理热搜归档', res.stats.removed);
    }
  } catch (e) { /* 集合/索引不存在时忽略 */ }

  try {
    const res = await db.collection(INTERP_CACHE)
      .where({ ts: _.lt(cacheCutoff) })
      .remove();
    if (res && res.stats && res.stats.removed) {
      console.log('清理解读缓存', res.stats.removed);
    }
  } catch (e) { /* 忽略 */ }

  // 每日用量记录只用于当天限流，30 天后无需保留
  try {
    const res = await db.collection('ai_usage')
      .where({ updatedAt: _.lt(cacheCutoff) })
      .remove();
    if (res && res.stats && res.stats.removed) {
      console.log('清理用量记录', res.stats.removed);
    }
  } catch (e) { /* 忽略 */ }
}

exports.main = async (event) => {
  // 只允许定时触发器 / 控制台测试调用。小程序端可以按名字调用任意云函数，
  // 若不拦截，用户可以反复调用 prewarm 绕过 interpret 的个人额度，消耗大模型费用。
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { ok: false, error: 'forbidden：该函数仅限定时触发' };

  const e = event || {};
  const topN = Math.min(Number(e.topN) || TOP_N, 30);
  const batch = Math.min(Number(e.batch) || BATCH, 8);

  try {
    const hot = await cloud.callFunction({
      name: 'fetchNews',
      data: { channel: '热搜', force: !!e.force }
    });
    const r = (hot && hot.result) || {};
    if (!r.ok) {
      return { ok: false, error: '热搜拉取失败：' + (r.error || 'unknown') };
    }

    const list = (r.articles || []).slice(0, topN);
    // 有事实摘要的优先预热（它们是真正能生成解读的条目）
    list.sort((a, b) => (b.hasFacts ? 1 : 0) - (a.hasFacts ? 1 : 0));

    // 轮转窗口：每轮从不同位置取 batch 条，避免缓存命中的 Top 4 永远占位、
    // 导致第 5~20 条一直得不到预热。20 条榜单约 5 轮（50 分钟）可覆盖一遍。
    const slot = list.length
      ? Math.floor(Date.now() / (10 * 60 * 1000)) % list.length
      : 0;
    const rotated = list.slice(slot).concat(list.slice(0, slot));
    const targets = rotated.slice(0, batch);

    let generated = 0, cached = 0, refused = 0, failed = 0, noKey = false;

    const results = await mapLimit(targets, CONCURRENCY, async (a) => {
      const res = await cloud.callFunction({
        name: 'interpret',
        data: { id: a.id }
      });
      return (res && res.result) || { ok: false };
    });

    results.forEach((res) => {
      if (!res || res.ok === false) {
        if (res && res.code === 'NO_KEY') noKey = true;
        failed++;
        return;
      }
      if (res.cached) cached++;
      else if (res.result && res.result.canInterpret === false) refused++;
      else if (res.result && res.result.canInterpret === true) generated++;
      else failed++;
    });

    // 清理不必每轮都做，每小时执行一次即可（北京时间整点第 7 分钟）
    const bjMinute = new Date((Date.now() + 8 * 3600 * 1000)).getUTCMinutes();
    if (bjMinute < 10) await cleanup();

    return {
      ok: !noKey,
      error: noKey ? 'AI 解读未配置：请在 interpret 云函数环境变量中设置 DEEPSEEK_API_KEY' : '',
      topN,
      targets: targets.length,
      generated, cached, refused, failed
    };
  } catch (err) {
    console.error('prewarm 失败', err);
    return { ok: false, error: String(err.message || err) };
  }
};
