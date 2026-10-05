// src/core/dice.parser.js
const { Api } = require('telegram');

/**
 * 消息解析器
 *
 * 1. 骰子开奖消息（MessageMediaDice，点数 1–6）
 * 2. 开盘信号消息（🧧底注: 1u，识别词写死在 strategy-executor）
 * 3. 结算消息（❤️第xxx期输赢 … 骰子为: N …【用户ID】… 赢 4.75 💰）
 *
 * 骰类表情：🎲🎯⚽🏀🎳（1–6）；🎰 为 1–64，不作为本业务的开奖来源。
 */

const DICE_EMOTICONS = new Set(['🎲', '🎯', '⚽', '🏀', '🎳']);

/**
 * 解析消息是否为开奖（骰子消息）
 *
 * @param {object} message - GramJS CustomMessage
 * @returns {{
 *   msgId: string,
 *   senderId: string,
 *   value: number,
 *   msgType: string,
 *   rawText: string
 * }|null} 非开奖消息返回 null
 */
function parseDiceMessage(message) {
  const media = message?.media;
  if (!media || !(media instanceof Api.MessageMediaDice)) return null;

  // 仅接受 1–6 的骰类表情（🎰 老虎机为 1–64，不属于本业务开奖）
  if (!DICE_EMOTICONS.has(media.emoticon)) return null;

  const value = Number(media.value);
  if (!Number.isInteger(value) || value < 1 || value > 6) return null;

  return {
    msgId: String(message.id),
    senderId: message.senderId ? message.senderId.toString() : null,
    value,
    msgType: 'dice',
    rawText: typeof message.message === 'string' ? message.message : '',
  };
}

/**
 * 判断是否为开奖结算消息（形如「❤️第xxx期输赢 ❤️ 骰子为: N 闲家: …」）
 * 注意区分庄家汇总消息（「庄家本局输赢与余额汇总」不含「期输赢」）。
 *
 * @param {string|null} text
 * @returns {boolean}
 */
function isSettleMessage(text) {
  if (!text) return false;
  return String(text).includes('期输赢') && /骰子为[:：]/.test(String(text));
}

/**
 * 解析结算消息：开奖点数 + 用登录账号的用户 ID 匹配本账号的输赢
 *
 * 获胜行形如：　奔驰 迈巴赫 【7016374749】 大 5,赢 4.75 💰
 * 无获奖时为：　本期无获奖用户
 *
 * @param {string|null} text - 结算消息文本
 * @param {string} userId - 登录账号的 TG 用户 ID
 * @returns {{
 *   diceValue: number|null,
 *   matched: boolean,       // 结算名单中是否出现本账号
 *   isWin: boolean|null,    // matched 时才有意义
 *   profit: number|null     // 从消息解析出的盈亏金额（输的行可能解析不到）
 * }}
 */
function parseSettle(text, userId) {
  const raw = String(text || '');
  const diceMatch = raw.match(/骰子为[:：]\s*(\d+)/);
  const diceValue = diceMatch ? parseInt(diceMatch[1], 10) : null;

  const meLine = raw
    .split('\n')
    .find((line) => line.includes(`【${userId}】`));

  if (!meLine) {
    return { diceValue, matched: false, isWin: null, profit: null };
  }

  // 行内同时含「赢」与「输」时按出现位置判断
  const winMatch = meLine.match(/赢\s*([\d.]+)/);
  const loseMatch = meLine.match(/输\s*([\d.]+)/);
  let isWin;
  let profit = null;
  if (winMatch && (!loseMatch || winMatch.index < loseMatch.index)) {
    isWin = true;
    profit = parseFloat(winMatch[1]);
  } else if (loseMatch) {
    isWin = false;
    profit = -parseFloat(loseMatch[1]);
  } else {
    isWin = false;
  }

  return { diceValue, matched: true, isWin, profit: Number.isFinite(profit) ? profit : null };
}

module.exports = { parseDiceMessage, isSettleMessage, parseSettle };
