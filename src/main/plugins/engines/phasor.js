'use strict';
/**
 * engine: phasor —— 相量图（电压 / 电流复数）。
 * 本轮只画题目给定或用户修改后的相量，不做交流求解与验算。
 */

const { solvePhasor } = require('../../../shared/plugins/phasorSolver.js');

const SCHEMA = `{
  "kind": "phasor",
  "title": "一句话概括（可选）",
  "reference": { "label": "U̇₁", "angle": 0 },
  "phasors": [
    { "id": "U1", "label": "U̇₁", "quantity": "voltage", "magnitude": 220, "unit": "V", "angle": 0 },
    { "id": "I1", "label": "İ₁", "quantity": "current", "magnitude": 5, "unit": "A", "angle": -36.9 }
  ],
  "ask": [ "画相量图" ],
  "ambiguities": []
}`;

const RULES = `相量图 IR 规则：
1. quantity 只能是 voltage（电压）或 current（电流）；幅值 magnitude 只写数字，单位写 unit（V / kV / A / mA）。
2. angle 是相位角（度，逆时针为正），angleUnit 默认 deg；题目用弧度时写 angleUnit: "rad"。
3. reference 是参考轴，一般取题目指定的参考相量，angle 通常为 0。
4. 只转写题目明确给出的相量（幅值、有效值/最大值、相位）。题目没有给出的量不要自己算，
   也不要假装算出来：需要求解的相量不要放进 phasors，把要求写进 ask。
5. 如果题目给的是瞬时值表达式或功率，先换算成题目所给信息能确定的相量；无法确定时写进 ambiguities。
6. 读图或读数不确定时，在 ambiguities 里写 { "question": "…？", "options": ["…"], "about": "U̇₁" }。`;

module.exports = {
  id: 'phasor',
  label: '相量图（电压 / 电流）',
  kind: 'phasor',
  description: '按给定的复数电压 / 电流绘制相量图；交流求解未接入时不输出未经校验的数值',
  describeSchema: () => `${SCHEMA}\n\n${RULES}`,
  solve: (ir, options) => solvePhasor(ir, options),
};
