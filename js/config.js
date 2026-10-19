// js/config.js —— 需要你自己申请/配置的值

// 1. 云开发环境ID：开发者工具「云开发」控制台首页可查（或左上角环境下拉→设置）。
//    留空则使用默认环境（仅一个环境时可行）
export const CLOUD_ENV = '';

// 2. 订阅消息模板ID：小程序后台 → 订阅消息 → 从公共模板库选一个
//    如「每日热点提醒」「资讯订阅成功通知」，把字段(如 thing1/time2)记下来，
//    与 cloudfunctions/dailyPush 里的 data 字段名对应修改
export const SUB_TEMPLATE_ID = '请填入小程序后台选择的订阅消息模板ID';

// 3. 大模型 API Key 不写在这里！
//    DeepSeek key 请配置到云函数 interpret 的「环境变量 DEEPSEEK_API_KEY」。
//    实时热搜（微博 / 百度）和 AI 解读全部经云函数代理，前端不接触任何 key。
