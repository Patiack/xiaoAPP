// js/data.js —— 频道与本地示例内容库（汇总入口）
// 说明：实时热搜由云函数 fetchNews（微博 + 百度）提供；本文件仅作为
//      未开通云开发 / 热搜源不可用时的离线兜底，界面会明确标注「示例」。
//      本地内容同样遵守：只转述有权威来源的事实，解读只作方法论分析，
//      不猜测、不传谣、不对未证实信息下结论。
//
// 文章按频道拆分在 js/articles/ 下维护，每频道 10 条，便于增删：
import life from './articles/life.js';
import social from './articles/social.js';
import tech from './articles/tech.js';
import mil from './articles/mil.js';
import ent from './articles/ent.js';
import cul from './articles/cul.js';
import music from './articles/music.js';
import auto from './articles/auto.js';
import fin from './articles/fin.js';

export const CHANNELS = ['生活', '社会', '科技', '军事', '娱乐', '文化', '音乐', '汽车', '财经'];

// 汇总全部文章；新增频道文章只需在上方 import 并加入此数组
const ARTICLES = [].concat(life, social, tech, mil, ent, cul, music, auto, fin);

// ---------------- 每日轮换与查询 ----------------

// 以"天"为单位的种子：同一天内推荐结果稳定，次日自动轮换
export function daySeed() {
  return Math.floor(Date.now() / 86400000);
}

export function todayLabel() {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 星期${week[d.getDay()]}`;
}

export function byChannel(channel) {
  return ARTICLES.filter(a => a.channel === channel);
}

// 每个频道按日期轮换出一条"今日聚焦"
export function dailyPick(channel) {
  const list = byChannel(channel);
  if (!list.length) return null;
  const idx = daySeed() % list.length;
  return list[idx];
}

// 推荐流：订阅的每个频道各出一条今日聚焦
export function recommended(subChannels) {
  return CHANNELS
    .filter(c => subChannels.includes(c))
    .map(c => dailyPick(c))
    .filter(Boolean);
}

export function findById(id) {
  return ARTICLES.find(a => a.id === id);
}

// 全文搜索：标题/摘要/正文/频道/解读 任一命中即返回
export function searchAll(keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return [];
  return ARTICLES.filter(a =>
    a.title.toLowerCase().includes(kw) ||
    a.digest.toLowerCase().includes(kw) ||
    a.channel.toLowerCase().includes(kw) ||
    (a.viewpoint.lead || '').toLowerCase().includes(kw) ||
    a.content.some(p => p.toLowerCase().includes(kw)) ||
    a.viewpoint.paras.some(p => p.m.toLowerCase().includes(kw) || p.t.toLowerCase().includes(kw))
  );
}
