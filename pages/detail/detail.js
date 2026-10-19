// pages/detail/detail.js —— 详情页（实时热搜 + AI 视点 / 本地示例文章）
import { findById, byChannel, todayLabel } from '../../js/data.js';
import { findRemote, interpretRemote, cloudReady } from '../../js/source.js';

Page({
  data: {
    article: null,
    related: [],
    today: '',
    ai: null,          // { canInterpret, reason, title, lead, paras, uncertain }
    aiLoading: false,
    aiError: '',
    aiCached: false
  },

  onLoad(options) {
    this.show(options && options.id);
  },

  show(id) {
    if (!id) {
      this.setData({ article: null });
      return;
    }

    const local = findById(id);
    if (local) {
      this.apply(local);
      return;
    }

    // 非本地 id：作为实时热搜解析（内存缓存命中即时；未命中回源云函数）
    wx.showLoading({ title: '加载中' });
    findRemote(id).then(remote => {
      wx.hideLoading();
      if (remote) this.apply(remote);
      else this.setData({ article: null });
    }).catch(() => {
      wx.hideLoading();
      this.setData({ article: null });
    });
  },

  apply(article) {
    const isRemote = !!article.remote;
    this.setData({
      article,
      today: todayLabel(),
      related: isRemote ? [] : byChannel(article.channel).filter(a => a.id !== article.id),
      ai: null,
      aiError: '',
      aiLoading: false,
      aiCached: false
    });
    wx.setNavigationBarTitle({ title: isRemote ? '实时热搜' : article.channel + ' · 热点' });

    if (isRemote) this.generateAI(article);
  },

  // 生成 AI 视点：云端按标题缓存；已预热过的条目会秒出
  generateAI(article) {
    if (!article || !article.remote) return;
    if (!cloudReady()) {
      this.setData({ aiError: '云开发未初始化，暂无法生成 AI 视点' });
      return;
    }

    this.setData({ aiLoading: true, aiError: '' });
    interpretRemote(article)
      .then(r => {
        if (!r || !r.result) {
          this.setData({ aiLoading: false, aiError: '暂未获取到视点，请稍后重试' });
          return;
        }
        this.setData({
          aiLoading: false,
          ai: r.result,
          aiCached: !!r.cached,
          aiError: ''
        });
      })
      .catch(err => {
        console.warn('AI 视点生成失败', err);
        let msg = 'AI 视点生成失败，请稍后重试';
        if (err && err.code === 'NO_KEY') {
          msg = 'AI 解读服务尚未配置：请在云函数 interpret 的环境变量中设置 DEEPSEEK_API_KEY';
        } else if (err && err.code === 'NOT_FOUND') {
          msg = '该条热点已过期，请返回热搜榜刷新后重试';
        } else if (err && err.code === 'QUOTA') {
          msg = err.message || '今日解读次数已用完';
        } else if (err && err.code === 'CLOUD_OFF') {
          msg = '云开发未初始化，暂无法生成 AI 视点';
        }
        this.setData({ aiLoading: false, aiError: msg });
      });
  },

  retryAI() {
    this.generateAI(this.data.article);
  },

  openRelated(e) {
    // 同页刷新，避免页面栈过深
    this.show(e.currentTarget.dataset.id);
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  // 原文链接：小程序不能直接打开外链，复制到剪贴板引导浏览器访问
  copyLink() {
    if (!this.data.article || !this.data.article.url) return;
    wx.setClipboardData({
      data: this.data.article.url,
      success: () => wx.showToast({ title: '链接已复制，可在浏览器打开', icon: 'none' })
    });
  },

  onShareAppMessage() {
    return {
      title: this.data.article ? this.data.article.title : '每日热点',
      path: '/pages/detail/detail?id=' + (this.data.article ? this.data.article.id : '')
    };
  }
});
