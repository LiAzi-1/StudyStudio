'use strict';
/**
 * 相量图数据（确定性部分）：只做校验、单位归一、直角坐标换算与“是否验算”标记。
 *
 * 本轮没有接入交流稳态求解器，因此：
 *   - 相量只能来自题目给定（source=given）；
 *   - 任何相量都不会被标记为“已验算”，界面必须显著提示未验算；
 *   - 若模型声称某个相量是“算出来的”（source=computed），这里拒绝把它当已验算值。
 */

const { formatNumber, round } = require('./circuitSolver.js');

const ANGLE_UNITS = { deg: 1, '°': 1, 度: 1, rad: 180 / Math.PI };

function toNumber(raw, fallback = NaN) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeQuantity(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (key === 'u' || key === '电压' || key === 'voltage') return 'voltage';
  if (key === 'i' || key === '电流' || key === 'current') return 'current';
  return '';
}

function emptyResult(errors = []) {
  return {
    ok: false,
    errors,
    warnings: [],
    assumptions: [],
    steps: [],
    phasors: [],
    reference: null,
    verified: false,
    unverified: true,
    notice: '',
    summary: [],
    needsClarification: false,
    ambiguities: [],
  };
}

function solvePhasor(ir, options = {}) {
  const ambiguities = Array.isArray(ir?.ambiguities) ? ir.ambiguities.filter((item) => item?.question) : [];
  if (ambiguities.length && !options.ignoreAmbiguities) {
    return { ...emptyResult(['读图存在歧义，请先确认下面的问题，确认后再画相量图']), needsClarification: true, ambiguities };
  }

  const errors = [];
  const warnings = [];
  const list = Array.isArray(ir?.phasors) ? ir.phasors : [];
  if (!list.length) errors.push('没有识别到任何相量');

  const phasors = [];
  list.forEach((item, index) => {
    const id = String(item?.id || `P${index + 1}`).slice(0, 40);
    const label = String(item?.label || id).slice(0, 40);
    const quantity = normalizeQuantity(item?.quantity);
    if (!quantity) {
      errors.push(`相量 ${label} 没有标明是电压还是电流`);
      return;
    }
    const magnitude = toNumber(item?.magnitude);
    if (!Number.isFinite(magnitude) || magnitude < 0) {
      errors.push(`相量 ${label} 的幅值无法识别`);
      return;
    }
    const angleUnit = String(item?.angleUnit || 'deg');
    const angleFactor = ANGLE_UNITS[angleUnit] || 1;
    const angle = toNumber(item?.angle, 0) * angleFactor;
    const unit = String(item?.unit || (quantity === 'voltage' ? 'V' : 'A')).slice(0, 12);
    const source = String(item?.source || 'given') === 'computed' ? 'computed' : 'given';
    if (source === 'computed') {
      warnings.push(`相量 ${label} 标记为“计算值”，但本机交流求解尚未接入，已按未验算值显示`);
    }
    const radians = (angle * Math.PI) / 180;
    phasors.push({
      id,
      label,
      quantity,
      magnitude: round(magnitude),
      unit,
      angle: round(angle),
      real: round(magnitude * Math.cos(radians)),
      imag: round(magnitude * Math.sin(radians)),
      source,
      verified: false,
    });
  });

  if (errors.length) return { ...emptyResult(errors), warnings };

  const referenceRaw = ir?.reference && typeof ir.reference === 'object' ? ir.reference : {};
  const reference = {
    label: String(referenceRaw.label || '参考相量').slice(0, 40),
    angle: round(toNumber(referenceRaw.angle, 0) * (ANGLE_UNITS[String(referenceRaw.angleUnit || 'deg')] || 1)),
  };

  const assumptions = [
    '相量取自题目给定值；本机交流稳态求解尚未接入，图中数值未做验算',
    '角度按逆时针为正，参考轴为 0°',
  ];

  return {
    ok: true,
    errors: [],
    warnings,
    assumptions,
    steps: [],
    phasors,
    reference,
    verified: false,
    unverified: true,
    notice: '交流求解尚未接入：本图只按题目给定的复数绘制，未做数值验算；凡标注“计算值”的相量均不可信。',
    summary: [
      `共 ${phasors.length} 个相量：电压 ${phasors.filter((item) => item.quantity === 'voltage').length} 个，电流 ${phasors.filter((item) => item.quantity === 'current').length} 个`,
    ],
    needsClarification: false,
    ambiguities: [],
  };
}

module.exports = { solvePhasor, formatNumber };
