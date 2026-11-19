'use strict';
/**
 * engine: circuit —— 电路题（元件 + 连接）。
 * 这里只描述「IR 长什么样 + 交给谁算」，具体计算在 shared/plugins/circuitSolver.js。
 */

const { solveCircuit } = require('../../../shared/plugins/circuitSolver.js');

const SCHEMA = `{
  "kind": "circuit",
  "title": "一句话概括这道题（可选）",
  "nodes": [
    { "id": "n1", "label": "A" }
  ],
  "elements": [
    { "id": "R1", "label": "R₁", "type": "resistor", "value": 6, "unit": "Ω", "from": "n1", "to": "n2" },
    { "id": "Us1", "label": "U_S", "type": "voltage_source", "value": 12, "unit": "V", "from": "n1", "to": "n0" },
    { "id": "Is1", "label": "I_S", "type": "current_source", "value": 2, "unit": "A", "from": "n2", "to": "n0" },
    { "id": "S1", "label": "S", "type": "switch", "state": "closed", "from": "n1", "to": "n2" },
    { "id": "C1", "label": "C", "type": "capacitor", "value": 10, "unit": "μF", "from": "n2", "to": "n0" },
    { "id": "L1", "label": "L", "type": "inductor", "value": 5, "unit": "mH", "from": "n2", "to": "n3" }
  ],
  "port": { "plus": "n1", "minus": "n0" },
  "given": [ { "symbol": "U_S", "value": 12, "unit": "V", "text": "电源电压 12V" } ],
  "ask": [ "求端口等效电阻" ],
  "ambiguities": []
}`;

const RULES = `电路 IR 规则：
1. type 只能是 resistor / voltage_source / current_source / capacitor / inductor / switch / wire / ammeter / voltmeter。
2. 每个元件必须用 from / to 连接已声明的节点；节点 id 用 n1、n2…，标签用 A、B、C 或题干里的字母。
3. 电压源：value 为正时，from 是正极、to 是负极（U_from − U_to = value）。
4. 电流源：箭头方向为元件内部 from → to，因此对外电路而言电流从 to 流出、从 from 流入。
5. 单位：电阻 Ω / kΩ / MΩ，电压 V / mV / kV，电流 A / mA。不要把单位写进 value，数值只写数字。
6. 直流稳态：电容按开路、电感按短路处理，你仍然照实给出元件即可。
7. 如果题目要求「等效电阻 / 戴维南 / 诺顿」，用 port 标出待求端口（plus 为正端）。
8. 读图有任何不确定（元件接在哪个节点、数值看不清、开关状态、元件类型），不要猜：
   在 ambiguities 里逐条写 { "question": "……？", "options": ["选项A", "选项B"], "about": "R3" }，
   并保持其余结构照常输出。`;

module.exports = {
  id: 'circuit',
  label: '电路（元件 + 连接）',
  kind: 'circuit',
  description: '直流电阻网络：串并联、星三角、分压分流、戴维南 / 诺顿等效',
  describeSchema: () => `${SCHEMA}\n\n${RULES}`,
  solve: (ir, options) => solveCircuit(ir, options),
};
