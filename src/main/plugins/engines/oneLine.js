'use strict';
/**
 * engine: one-line —— 单线图（母线 + 支路 + 负荷）。
 * 计算在 shared/plugins/oneLineSolver.js：辐射状网络的下游负荷累加与压降。
 */

const { solveOneLine } = require('../../../shared/plugins/oneLineSolver.js');

const SCHEMA = `{
  "kind": "one-line",
  "title": "一句话概括这张单线图（可选）",
  "buses": [
    { "id": "B1", "label": "10kV 母线", "voltage": 10, "unit": "kV" },
    { "id": "B2", "label": "0.4kV 母线", "voltage": 0.4, "unit": "kV" }
  ],
  "sources": [
    { "id": "G1", "label": "系统电源", "bus": "B1", "voltage": 10, "unit": "kV" }
  ],
  "branches": [
    { "id": "L1", "label": "线路1", "type": "line", "from": "B1", "to": "B2", "r": 0.5, "x": 0.4, "unit": "Ω" },
    { "id": "T1", "label": "变压器1", "type": "transformer", "from": "B2", "to": "B3", "ratio": "10/0.4" }
  ],
  "loads": [
    { "id": "LD1", "label": "负荷1", "bus": "B3", "p": 500, "unit": "kW", "pf": 0.9 }
  ],
  "ask": [ "求各母线电压与线路电流" ],
  "ambiguities": []
}`;

const RULES = `单线图 IR 规则：
1. buses 是母线，branches 是线路 / 变压器，loads 挂在母线上，sources 是电源接入点。
2. branch.type 只能是 line 或 transformer；line 用 r / x（总阻抗，Ω），有每公里参数时用 rPerKm / xPerKm + length（km）。
3. 变压器用 ratio 字符串表示变比，如 "10/0.4"（一次侧/二次侧）。
4. 负荷 p 用 kW 或 MW，pf 是功率因数（0–1）；题目没给功率因数时省略 pf，不要自己编。
5. 母线电压 unit 用 kV，数值只写数字。
6. 这张单线图必须是辐射状（树形）。如果图里有环网、联络开关状态不清，写进 ambiguities，不要自行假设。
7. 读图有任何不确定（哪条支路接到哪条母线、参数看不清、负荷挂点），在 ambiguities 里逐条写
   { "question": "……？", "options": ["选项A", "选项B"], "about": "L1" }，其余结构照常输出。`;

module.exports = {
  id: 'one-line',
  label: '单线图（母线 + 支路）',
  kind: 'one-line',
  description: '辐射状单线图：下游负荷累加、线路压降、变压器变比折算',
  describeSchema: () => `${SCHEMA}\n\n${RULES}`,
  solve: (ir, options) => solveOneLine(ir, options),
};
