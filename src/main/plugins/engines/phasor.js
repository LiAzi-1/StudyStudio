'use strict';
/**
 * engine: phasor —— 相量图（电压 / 电流复数，或定性分析题的调节前后轨迹）。
 *
 * 两种模式：
 *   given       —— 题目给出具体电压 / 电流（幅值 + 相位），只按给定值画图；
 *   qualitative —— 题目没有具体数值，要求画轨迹、判断变化（同步电机调有功 / 调励磁 / 功角等），
 *                  由内置分析套路给出归一化示意相量与分步图。
 */

const { solvePhasor } = require('../../../shared/plugins/phasorSolver.js');

const SCHEMA = `{
  "kind": "phasor",
  "mode": "given",
  "title": "一句话概括（可选）",
  "reference": { "label": "U̇₁", "angle": 0 },
  "phasors": [
    { "id": "U1", "label": "U̇₁", "quantity": "voltage", "magnitude": 220, "unit": "V", "angle": 0 },
    { "id": "I1", "label": "İ₁", "quantity": "current", "magnitude": 5, "unit": "A", "angle": -36.9 }
  ],
  "ask": [ "画相量图" ],
  "ambiguities": []
}`;

const QUALITATIVE_SCHEMA = `{
  "kind": "phasor",
  "mode": "qualitative",
  "title": "隐极同步发电机增加有功、保持无功不变",
  "qualitative": {
    "machine": "cylindrical-sync-generator",
    "change": "active",
    "hold": "reactive",
    "direction": "increase"
  },
  "ask": [ "画出 E0 和 I 的变化轨迹，并说明各量如何变化" ]
}`;

const RULES = `相量图 IR 规则：
1. 先判断题型，mode 只能是 given 或 qualitative。
2. mode=given：题目给出了电压 / 电流的具体数值（幅值、有效值或相位）。
   - quantity 只能是 voltage（电压）或 current（电流）；幅值 magnitude 只写数字，单位写 unit（V / kV / A / mA）。
   - angle 是相位角（度，逆时针为正），angleUnit 默认 deg；题目用弧度时写 angleUnit: "rad"。
   - reference 是参考轴，一般取题目指定的参考相量，angle 通常为 0。
   - 只转写题目明确给出的相量（幅值、有效值/最大值、相位）。题目没有给出的量不要自己算，也不要假装算出来：需要求解的相量不要放进 phasors，把要求写进 ask。
   - 题目给的是瞬时值表达式或功率，先换算成题目所给信息能确定的相量；无法确定时写进 ambiguities。
3. mode=qualitative：题目没有具体数值，但要求「画相量图 / 画 E0 和 I 的变化轨迹 / 说明各量如何变化 / 定性分析」，
   且分析对象是同步发电机调节有功、无功、励磁或功角。典型问法：
   「增加有功而保持无功不变」「只调节励磁」「保持励磁不变增加有功」「功角 / 功率因数角如何变化」。
   - 一律用 qualitative，不要因为没有数字就放弃、也不要自己编造具体数值。
   - qualitative.machine 目前只支持 "cylindrical-sync-generator"（隐极同步发电机，并联大电网）。
   - qualitative.change 表示调节哪个量：active（有功）/ reactive（无功）/ excitation（励磁电流）。
   - qualitative.hold 表示保持哪个量不变：reactive（无功）/ active（有功）/ excitation（励磁）。
   - qualitative.direction 表示调节方向：increase / decrease，默认 increase。
   - 可分析组合：change=active + hold=reactive；change=excitation 或 reactive + hold=active；change=active + hold=excitation。
   - 数值由引擎按归一化示意值绘制，不要填写 magnitude；把题目的问法原样写进 ask。
4. 题目同时给出数值又要求画轨迹时：数值题用 given；纯轨迹 / 变化趋势题用 qualitative。拿不准时按题目是否要求「算出具体数值」判断。
5. 读图或读数不确定时，在 ambiguities 里写 { "question": "…？", "options": ["…"], "about": "U̇₁" }。
   定性题缺少数值不算歧义，不要因此填写 ambiguities。`;

module.exports = {
  id: 'phasor',
  label: '相量图（电压 / 电流 / 定性轨迹）',
  kind: 'phasor',
  description: '按给定复数绘制相量图；没有数值的定性题按隐极同步发电机调节套路输出分步轨迹图',
  describeSchema: () => `${SCHEMA}\n\n${QUALITATIVE_SCHEMA}\n\n${RULES}`,
  solve: (ir, options) => solvePhasor(ir, options),
};
