// src/core/rule.engine.js
const logger = require('../utils/logger');

/**
 * 规则引擎（纯计算，无 IO）
 *
 * 动态监测模型：
 *   规则只配置一个 N（streak_count）：
 *     连续 N 次开出「大」（4-6 点）→ 自动反向下注「小」
 *     连续 N 次开出「小」（1-3 点）→ 自动反向下注「大」
 *   大连击与小组击分别独立监测，下注方向取连击属性的反方向。
 *
 * 指令文本固定为 "<方向标签> <金额>"（与 pc28 一致），
 * 金额 = base_bet × ratio^连败次数（无上限倍投）。
 */

/**
 * 点数 → 大小属性
 * @param {number} value - 骰子点数 1–6
 * @returns {'BIG'|'SMALL'}
 */
function sizeOf(value) {
  return Number(value) >= 4 ? 'BIG' : 'SMALL';
}

/**
 * 反方向
 */
function opposite(direction) {
  return direction === 'BIG' ? 'SMALL' : 'BIG';
}

/**
 * 动态监测判定：本条开奖是否构成「连续 N 次同大小」，构成则给出反向下注方向。
 *
 * @param {object} rule - rules 表行（streak_count）
 * @param {number} value - 本条开奖点数 1–6
 * @param {number[]} recentValues - 本群此前的开奖点数（新→旧，不含本条）
 * @returns {'BIG'|'SMALL'|null} 应下注的方向；未触发返回 null
 */
function evaluateStreak(rule, value, recentValues) {
  const n = Math.max(2, rule.streak_count || 2);
  const size = sizeOf(value);

  // 本条之前的最近 n-1 条必须与本条同大小，才构成连续 n 次
  const history = recentValues.slice(0, n - 1);
  if (history.length < n - 1) return null;
  if (!history.every((v) => sizeOf(v) === size)) return null;

  return opposite(size);
}

/**
 * 计算下注金额（无上限倍投）
 * 无论连败多少次，严格按照 base × (ratio ^ losses) 计算
 */
function calcAmount(base, ratio, losses) {
  if (base <= 0) throw new Error('基础下注金额必须 > 0');
  if (ratio < 1.0) throw new Error('倍投比例必须 >= 1.0');

  return Math.round(base * Math.pow(ratio, losses));
}

/**
 * 当前连败的累计投入（用于止损判定）
 * 从第 0 次连败到第 losses 次连败的注金之和
 */
function calcCumulativeStake(base, ratio, losses) {
  let total = 0;
  for (let i = 0; i <= losses; i++) {
    total += Math.round(base * Math.pow(ratio, i));
  }
  return total;
}

/**
 * 生成下注指令文本："<方向标签> <金额>"，如 "小 100"
 */
function buildBetText(direction, amount) {
  const label = direction === 'BIG' ? '大' : '小';
  return `${label} ${amount}`;
}

/**
 * 生成规则的可读描述
 */
function describeRule(rule) {
  return `连续 ${rule.streak_count} 次开出「大」→ 买「小」；连续 ${rule.streak_count} 次开出「小」→ 买「大」`;
}

module.exports = {
  sizeOf,
  opposite,
  evaluateStreak,
  calcAmount,
  calcCumulativeStake,
  buildBetText,
  describeRule,
};
