// js/source.js —— 数据源适配层：实时热搜（云函数）+ AI 视点解读
// 未开通云开发时全部静默降级为本地示例数据，产品功能不受影响

import { CLOUD_ENV } from './config.js';

// 云开发是否可用（app.js 初始化时写入）；注意必须在调用时才能 getApp()
export function cloudReady() {
  const app = getApp();
  return !!(app && app.globalData && app.globalData.cloudReady);
}

export function initCloud() {
  if (!wx.cloud) return false;
  try {
    wx.cloud.init(CLOUD_ENV ? { env: CLOUD_ENV, traceUser: true } : { traceUser: true });
    return true;
  } catch (e) {
    console.warn('云开发初始化失败，降级为本地数据', e);
    return false;
  }
}

// 统一错误对象，便于页面区分「未配置 key / 过期 / 额度用完」
function makeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function cacheArticles(list) {
  const app = getApp();
  const cache = app.globalData.remoteById || {};
  (list || []).forEach(a => { if (a && a.id) cache[a.id] = a; });
  app.globalData.remoteById = cache;
}

// 字段规范化：保证 id/title/digest/channel/heat/source 结构统一
export function normArticle(a) {
  a = a || {};
  const content = Array.isArray(a.content) && a.content.length
    ? a.content
    : [a.digest || a.title || ''];
  return Object.assign({}, a, {
    id: a.id,
    title: a.title || '',
    digest: a.digest || a.title || '',
    content,
    channel: a.channel || '热点',
    heat: a.heat || '实时',
    source: a.source || '全网热搜',
    remote: !!a.remote || /^hot_/.test(a.id || ''),
    hot: !!a.hot || /^hot_/.test(a.id || '')
  });
}

export function normRemote(list) {
  return (list || [])
    .filter(a => a && a.title)
    .map(normArticle);
}

// 拉取实时热搜
// opt: { channel, keyword, source: 'all'|'baidu'|'weibo', force }
// 返回 Promise<{ articles, updatedAt, updatedLabel, sources, cached }>
export function fetchHot(opt) {
  const o = opt || {};
  if (!cloudReady()) return Promise.reject(makeError('CLOUD_OFF', '云开发未初始化'));
  return wx.cloud.callFunction({
    name: 'fetchNews',
    data: {
      channel: o.channel || '',
      keyword: o.keyword || '',
      source: o.source || 'all',
      force: !!o.force
    },
    timeout: 25000
  }).then(res => {
    const r = (res && res.result) || {};
    if (!r.ok) throw makeError('FETCH_FAILED', r.error || '热搜拉取失败');
    const articles = normRemote(r.articles || []);
    cacheArticles(articles);
    return {
      articles,
      updatedAt: r.updatedAt || Date.now(),
      updatedLabel: r.updatedLabel || '',
      sources: r.sources || {},
      cached: !!r.cached
    };
  }).catch(err => {
    if (err && err.code) throw err;
    console.warn('fetchNews 云函数调用失败', err);
    throw makeError('FETCH_FAILED', (err && (err.errMsg || err.message)) || '热搜拉取失败');
  });
}

// 兼容旧调用：只返回数组
export function fetchRemote(opt) {
  return fetchHot(opt).then(r => r.articles);
}

// 按 id 找热搜条目（详情页分享/推送深链用）
export function findRemote(id) {
  const app = getApp();
  const hit = (app.globalData.remoteById || {})[id];
  if (hit) return Promise.resolve(hit);
  if (!/^hot_/.test(String(id || '')) || !cloudReady()) return Promise.resolve(null);
  return wx.cloud.callFunction({ name: 'fetchNews', data: { id }, timeout: 25000 })
    .then(res => {
      const r = (res && res.result) || {};
      const a = r.article ? normArticle(r.article) : null;
      if (a) cacheArticles([a]);
      return a;
    })
    .catch(() => null);
}

// 请求 AI 视点解读（云端按标题缓存，同一话题只生成一次）
// 返回 Promise<{ ok, cached, result, generatedAt }>
// result: { canInterpret, reason, title, lead, paras: [{m,t}], uncertain }
export function interpretRemote(article) {
  if (!cloudReady()) return Promise.reject(makeError('CLOUD_OFF', '云开发未初始化'));
  if (!article || !article.id) return Promise.reject(makeError('BAD_REQUEST', '缺少热点 id'));

  const app = getApp();
  const cache = app.globalData.aiById || {};
  if (cache[article.id]) {
    return Promise.resolve({ ok: true, cached: true, result: cache[article.id] });
  }

  // 首次生成可能耗时 5~40s（云函数超时配置为 60s），客户端显式放宽等待时间
  return wx.cloud.callFunction({ name: 'interpret', data: { id: article.id }, timeout: 60000 })
    .then(res => {
      const r = (res && res.result) || {};
      if (!r.ok) throw makeError(r.code || 'INTERPRET_FAILED', r.error || '解读生成失败');
      if (r.result) {
        app.globalData.aiById = app.globalData.aiById || {};
        app.globalData.aiById[article.id] = r.result;
      }
      return r;
    })
    .catch(err => {
      if (err && err.code) throw err;
      console.warn('interpret 云函数调用失败', err);
      throw makeError('INTERPRET_FAILED', (err && (err.errMsg || err.message)) || '解读生成失败');
    });
}
