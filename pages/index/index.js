// pages/index/index.js —— 今日热点：实时热搜（微博 + 百度）+ 频道筛选 + 推荐流
import { CHANNELS, todayLabel, recommended, byChannel, dailyPick } from '../../js/data.js';
import { cloudReady, fetchHot } from '../../js/source.js';

Page({
  data: {
    today: '',
    tabs: ['热搜', '推荐'].concat(CHANNELS),
    currentTab: '热搜',
    list: [],
    loading: false,
    remoteOn: false,
    sourceLabel: '',
    updatedLabel: '',
    errorMsg: '',
    isFallback: false
  },

  onLoad(options) {
    this.hotAll = [];
    this._loading = false;
    const ch = options && options.channel;
    const currentTab = ch && this.data.tabs.indexOf(ch) > -1 ? ch : '热搜';
    this.setData({
      today: todayLabel(),
      currentTab,
      remoteOn: cloudReady()
    });
  },

  onShow() {
    // 每次显示都刷新日期；跨天/订阅变更后重建列表
    this.setData({ today: todayLabel() });
    if (!cloudReady()) {
      this.fallbackLocal(this.data.currentTab);
      return;
    }
    if (!this.hotAll.length) this.loadHot(false);
    else this.buildList(this.data.currentTab);
  },

  // 拉取实时热搜（force=true 时绕过云端 8 分钟缓存）
  loadHot(force) {
    if (this._loading) return Promise.resolve();
    this._loading = true;
    this.setData({ loading: true, errorMsg: '' });

    return fetchHot({ force: !!force })
      .then(r => {
        this._loading = false;
        this.hotAll = r.articles || [];
        this.setData({
          loading: false,
          remoteOn: true,
          sourceLabel: this.sourceLabel(r.sources),
          updatedLabel: r.updatedLabel || '',
          errorMsg: '',
          isFallback: false
        });
        this.buildList(this.data.currentTab);
      })
      .catch(err => {
        this._loading = false;
        console.warn('实时热搜加载失败', err);
        const msg = err && err.code === 'CLOUD_OFF'
          ? '云开发未初始化，已展示本地示例内容'
          : '实时热搜暂时不可用，已展示本地示例内容';
        this.setData({ loading: false, errorMsg: msg, isFallback: true });
        this.fallbackLocal(this.data.currentTab);
      });
  },

  sourceLabel(sources) {
    const names = [];
    if (sources && sources.baidu) names.push('百度热搜');
    if (sources && sources.weibo) names.push('微博热搜');
    return names.join(' + ') || '实时热搜';
  },

  buildList(tab) {
    if (!this.hotAll || !this.hotAll.length) {
      if (!this._loading) this.fallbackLocal(tab);
      return;
    }

    let list;
    if (tab === '热搜') {
      list = this.hotAll.slice(0, 50);
    } else if (tab === '推荐') {
      const subs = wx.getStorageSync('subChannels') || CHANNELS;
      list = this.recommend(this.hotAll, subs);
    } else {
      list = this.hotAll.filter(a => a.channel === tab);
    }

    this.setData({
      list: list.map(a => this.decorate(a, tab)),
      isFallback: false
    });
  },

  decorate(a, tab) {
    const sources = a.sources || [];
    let sourceShort = a.source || '';
    if (sources.length === 2) sourceShort = '百度+微博';
    else if (sources[0]) sourceShort = sources[0].replace('热搜', '');
    return Object.assign({}, a, {
      sourceShort,
      showRank: tab === '热搜',
      top: tab === '热搜' && a.rank >= 1 && a.rank <= 3,
      hint: a.hasFacts ? 'AI 视点解读 ›' : '事实不足 · 暂不解读 ›'
    });
  },

  // 推荐流：全站 Top 5 + 每个订阅频道 Top 2，去重后取 15 条
  recommend(hot, subs) {
    const picked = [];
    const seen = {};
    const add = a => {
      if (a && a.id && !seen[a.id]) { seen[a.id] = 1; picked.push(a); }
    };
    const factual = hot.filter(a => a.hasFacts);
    (factual.length ? factual : hot).slice(0, 5).forEach(add);
    (subs || []).forEach(ch => {
      const candidates = hot.filter(a => a.channel === ch);
      const ordered = candidates.filter(a => a.hasFacts)
        .concat(candidates.filter(a => !a.hasFacts));
      ordered.slice(0, 2).forEach(add);
    });
    return picked.slice(0, 15);
  },

  // 未开通云开发 / 实时源失败：退回本地示例内容，界面明确标注
  fallbackLocal(tab) {
    const subs = wx.getStorageSync('subChannels') || CHANNELS;
    let base;
    if (tab === '热搜' || tab === '推荐') {
      base = recommended(subs);
      if (!base.length) base = recommended(CHANNELS);
    } else {
      const pick = dailyPick(tab);
      base = byChannel(tab).map(a => Object.assign({}, a, {
        daily: !!(pick && a.id === pick.id)
      }));
    }
    this.setData({
      list: base.map(a => Object.assign({}, a, { showRank: false, sourceShort: '' })),
      isFallback: true
    });
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ currentTab: tab });
    if (!cloudReady()) {
      this.fallbackLocal(tab);
      return;
    }
    if (this.hotAll && this.hotAll.length) this.buildList(tab);
    else if (!this._loading) this.loadHot(false);
  },

  openSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  openFocus() {
    wx.navigateTo({ url: '/pages/focus/focus' });
  },

  openDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  // 下拉刷新：强制重拉实时热搜
  onPullDownRefresh() {
    if (!cloudReady()) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadHot(true).then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return { title: '每日热点 · 实时热搜与唯物主义视点解读', path: '/pages/index/index' };
  }
});
