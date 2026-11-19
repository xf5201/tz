// src/core/number.attributes.js
const logger = require('../utils/logger');

/**
 * 骰子属性分析引擎
 *
 * 监听群的开奖消息统一为 Telegram 骰子消息（MessageMediaDice），
 * 结果值为 1–6。属性判定规则：
 *
 * 方向枚举：
 *   BIG   → 点数 4–6（大）
 *   SMALL → 点数 1–3（小）
 *   ODD   → 点数为奇数（单）
 *   EVEN  → 点数为偶数（双）
 */

const ATTRS = { BIG: 'BIG', SMALL: 'SMALL', ODD: 'ODD', EVEN: 'EVEN' };

const ATTR_LABEL = {
  BIG: '大',
  SMALL: '小',
  ODD: '单',
  EVEN: '双',
};

/**
 * 判断某个点数是否具备指定属性
 *
 * @param {number|null} value - 骰子点数 1–6
 * @param {string} attr - BIG | SMALL | ODD | EVEN
 * @returns {boolean}
 */
function attrMatch(value, attr) {
  if (value == null || !Number.isFinite(Number(value))) return false;
  const v = Number(value);
  switch (attr) {
    case ATTRS.BIG: return v >= 4;        // 4-6 为大
    case ATTRS.SMALL: return v <= 3;      // 1-3 为小
    case ATTRS.ODD: return v % 2 === 1;   // 奇数为单
    case ATTRS.EVEN: return v % 2 === 0;  // 偶数为双
    default:
      logger.warn(`[NUMBER_ATTR] 未知属性: ${attr}`);
      return false;
  }
}

/**
 * 分析单条开奖
 *
 * @param {number|null} value - 骰子点数
 * @returns {{ value: number, size: string, parity: string, direction: string }|null}
 */
function analyzeDice(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  const size = v >= 4 ? 'BIG' : 'SMALL';
  const parity = v % 2 === 1 ? 'ODD' : 'EVEN';
  return { value: v, size, parity, direction: size };
}

/**
 * 方向标签
 * @param {string} attr
 * @returns {string} 大/小/单/双
 */
function getAttrLabel(attr) {
  return ATTR_LABEL[attr] || attr;
}

/**
 * 校验属性合法性
 * @param {string} attr
 * @returns {boolean}
 */
function isValidAttr(attr) {
  return Object.values(ATTRS).includes(attr);
}

module.exports = {
  ATTRS,
  ATTR_LABEL,
  attrMatch,
  analyzeDice,
  getAttrLabel,
  isValidAttr,
};
