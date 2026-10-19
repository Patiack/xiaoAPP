// cloudfunctions/dailyPush/index.js —— 每日热点定时推送（订阅消息）
// 触发方式：定时触发器（config.json，每天 08:00）；也可在控制台手动「测试」调起
// 流程：拉取当日实时热搜 → 按用户订阅频道挑一条 → 发送订阅消息 → 扣减额度
//
// ⚠️ 环境变量：
//   SUB_TEMPLATE_ID  小程序后台选用订阅消息模板的 ID（必填）
//   PUSH_ENV=release 正式推送（默认 trial 体验版）
//
// ⚠️ 模板字段名须与下方 buildData 中 thing1/time2 对应，按你选的模板调整
const cloud = require('wx-server-sdk');
const common = require('./common.js');
// fetchNews 需要并行请求两个外部热榜接口（单接口超时 12s），
// 默认 15s 的 SDK 超时过于接近上限，这里放宽到 30s。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 30000 });
const db = cloud.database();
const _ = db.command;
const USERS = 'subscribe_users';

// 点击推送直达首页；携带频道参数可自动切到对应标签
const PAGE_PATH = '/pages/index/index';

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function buildData(title, now) {
  // 字段含义按「每日热点提醒」类模板通常约定：thing=主题/内容, time=时间
  // ⚠️ 请对照你申请模板时的字段列表（后台→订阅消息→我的模板）核对键名
  return {
    thing1: common.thingCut(title, 20),
    time2: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 08:00`
  };
}

// 拉取今日热搜（失败则回退为通用文案，不阻塞推送）
async function loadHotList() {
  try {
    const res = await cloud.callFunction({
      name: 'fetchNews',
      data: { channel: '热搜', force: true }
    });
    const r = (res && res.result) || {};
    return r.ok ? (r.articles || []) : [];
  } catch (e) {
    console.error('推送拉取热搜失败', e);
    return [];
  }
}

exports.main = async (event) => {
  // 只允许定时触发器 / 控制台测试调用，避免小程序端手动触发群发推送
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { ok: false, error: 'forbidden：该函数仅限定时触发' };

  const templateId = process.env.SUB_TEMPLATE_ID;
  if (!templateId) return { ok: false, error: '未配置环境变量 SUB_TEMPLATE_ID' };

  const now = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  const today = now.toISOString().slice(0, 10);
  const hotList = await loadHotList();

  // 当日是否已给该用户推送过（幂等保护，防止触发器重跑重复消耗额度）
  const sentKey = 'lastPushDay';

  const usersCol = db.collection(USERS);
  let sent = 0, failed = 0, skipped = 0;

  // 先把待推送用户完整取出来，再逐条发送。
  // 不能边发边分页：发送会修改 quota / lastPushDay，用户随即退出 where 条件，
  // 后续 skip 会跳过后面的用户，导致漏发。
  const users = [];
  for (let skip = 0; ; skip += 100) {
    const { data: batch } = await usersCol
      .where({ quota: _.gt(0) })
      .skip(skip).limit(100).get();
    if (!batch || !batch.length) break;
    users.push.apply(users, batch);
    if (batch.length < 100) break;
  }

  for (const u of users) {
    if (u[sentKey] === today) { skipped++; continue; }

    const channels = (u.channels && u.channels.length) ? u.channels : common.CHANNELS;
    const pick = common.pickForUser(hotList, channels);

    const title = pick ? pick.title : '今日实时热点已更新';
    const page = pick && pick.channel
      ? PAGE_PATH + '?channel=' + encodeURIComponent(pick.channel)
      : PAGE_PATH;

    // 一次性订阅额度=1 次/授权：每次只发 1 条汇总消息
    const msgData = buildData(title, now);

    try {
      const res = await cloud.openapi.subscribeMessage.send({
        touser: u._id,
        templateId,
        page,
        data: msgData,
        miniprogram_state: process.env.PUSH_ENV === 'release' ? 'formal' : 'trial'
      });
      const errcode = res.errCode !== undefined ? res.errCode : res.errcode;
      if (errcode === 0) {
        await usersCol.doc(u._id).update({
          data: { quota: _.inc(-1), [sentKey]: today, updatedAt: Date.now() }
        });
        sent++;
      } else if (errcode === 43101) {
        // 用户已在微信侧关闭接收：清零额度避免反复尝试
        await usersCol.doc(u._id).update({ data: { quota: 0, updatedAt: Date.now() } });
        skipped++;
      } else {
        console.error('push failed', u._id, errcode, res.errmsg);
        failed++;
      }
    } catch (e) {
      console.error('push error', u._id, e);
      failed++;
    }
  }

  return { ok: true, date: today, hotList: hotList.length, sent, failed, skipped };
};
