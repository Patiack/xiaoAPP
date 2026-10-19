// cloudfunctions/dailyPush/common.js —— 推送文案工具
exports.CHANNELS = ['生活', '社会', '科技', '军事', '娱乐', '文化', '音乐', '汽车', '财经'];

// thing 类字段长度上限 20 汉字，超长截断；避免把 emoji 代理对截成乱码
exports.thingCut = function (s, n) {
  s = String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const max = n || 20;
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
};

// 按用户订阅频道挑选当日最热的一条；订阅频道无热点时回退到全站第一
exports.pickForUser = function (list, channels) {
  list = list || [];
  if (!list.length) return null;
  channels = channels || [];
  if (channels.length) {
    const hit = list.find(function (a) { return channels.indexOf(a.channel) > -1; });
    if (hit) return hit;
  }
  return list[0];
};
