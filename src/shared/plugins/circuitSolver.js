'use strict';
/**
 * 直流电阻网络求解器（纯函数，无 Electron 依赖）。
 *
 * 设计约束：
 *   - 数值计算只在这里做，模型只负责把题目转成下面的 IR，不参与计算；
 *   - IR 有任何读图歧义时，先返回「待确认」，不猜；
 *   - 求解以节点电压法（MNA）为准，串并联 / 星三角 / 分压分流 / 电源等效
 *     作为可解释的化简步骤输出，并与 MNA 结果交叉校验。
 *
 * IR（circuit）：
 * {
 *   kind: 'circuit',
 *   nodes: [{ id, label }],
 *   elements: [{
 *     id, label, type, value, unit, from, to,
 *     state: 'closed'|'open'（开关）, direction: 'from'|'to'（电流源）
 *   }],
 *   port: { plus, minus },              // 待求端口（等效电阻 / 戴维南）
 *   given: [{ symbol, value, unit, text }],
 *   ask: ['求等效电阻'],
 *   ambiguities: [{ question, options, about }]
 * }
 */

const RES_UNITS = { 'Ω': 1, 'ohm': 1, '欧': 1, '欧姆': 1, 'kΩ': 1e3, 'KΩ': 1e3, 'MΩ': 1e6, 'mΩ': 1e-3 };
const VOL_UNITS = { V: 1, '伏': 1, '伏特': 1, mV: 1e-3, kV: 1e3 };
const CUR_UNITS = { A: 1, '安': 1, '安培': 1, mA: 1e-3, 'μA': 1e-6, uA: 1e-6 };

const TYPE_ALIASES = {
  R: 'resistor', resistor: 'resistor', '电阻': 'resistor', 电阻器: 'resistor',
  Us: 'voltage_source', voltage_source: 'voltage_source', vsource: 'voltage_source', '电压源': 'voltage_source',
  Is: 'current_source', current_source: 'current_source', isource: 'current_source', '电流源': 'current_source',
  L: 'inductor', inductor: 'inductor', '电感': 'inductor',
  C: 'capacitor', capacitor: 'capacitor', '电容': 'capacitor',
  S: 'switch', switch: 'switch', '开关': 'switch',
  wire: 'wire', '导线': 'wire', ammeter: 'ammeter', '电流表': 'ammeter',
  voltmeter: 'voltmeter', '电压表': 'voltmeter', '负载': 'resistor',
};

function normalizeType(raw) {
  const key = String(raw || '').trim();
  return TYPE_ALIASES[key] || TYPE_ALIASES[key.toLowerCase()] || '';
}

function toNumber(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw ?? '').trim().replace(/,/g, '');
  if (!text) return NaN;
  const match = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([a-zA-ZΩμµ]*)$/.exec(text);
  if (!match) return NaN;
  return Number(match[1]);
}

function toBaseUnit(value, unit, table) {
  const key = String(unit || '').trim();
  if (!key) return { value, unit: '' };
  const factor = table[key] || table[key.toLowerCase()];
  if (!factor) return { value: NaN, unit: key };
  return { value: value * factor, unit: key };
}

/** 统一成 Ω / V / A；无法识别时返回 NaN，由校验层报错 */
function normalizeValue(element) {
  const type = element.type;
  const raw = toNumber(element.value);
  if (!Number.isFinite(raw)) return { value: NaN, unit: '' };
  if (type === 'resistor') return toBaseUnit(raw, element.unit || 'Ω', RES_UNITS);
  if (type === 'voltage_source') return toBaseUnit(raw, element.unit || 'V', VOL_UNITS);
  if (type === 'current_source') return toBaseUnit(raw, element.unit || 'A', CUR_UNITS);
  return { value: raw, unit: element.unit || '' };
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return 0;
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-4) return Number(value.toPrecision(digits));
  return Number(value.toPrecision(digits));
}

/** 数值 + 单位的显示文本（求解步骤、结果表共用） */
function formatNumber(value, unit = '', digits = 4) {
  if (!Number.isFinite(value)) return '—';
  const num = round(value, digits);
  const text = Math.abs(num) >= 1e5 || (Math.abs(num) < 1e-3 && num !== 0)
    ? num.toExponential(3).replace('e+', '×10^').replace('e-', '×10^-')
    : String(num);
  return unit ? `${text} ${unit}` : text;
}

/* -------------------------------------------------------------- 拓扑整理 */

function createUnionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

function dominantLabel(group, nodesById) {
  return nodesById.get(group)?.label || group;
}

/**
 * 直流稳态下的理想化：
 *   - 闭合开关 / 导线 / 电流表 / 电感 / 0Ω 电阻 → 用并查集并点（短路）；
 *   - 断开开关 / 电容 / 电压表 → 视为开路移除；
 *   - 理想电压源两端并点只在「值为 0」时成立，其余交给 MNA。
 */
function prepareTopology(ir) {
  const errors = [];
  const warnings = [];
  const assumptions = [];
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  const nodesById = new Map();
  nodes.forEach((node, index) => {
    const id = String(node?.id || '').trim();
    if (!id) {
      errors.push(`第 ${index + 1} 个节点缺少 id`);
      return;
    }
    if (nodesById.has(id)) {
      errors.push(`节点 id 重复：${id}`);
      return;
    }
    nodesById.set(id, { id, label: String(node.label || id) });
  });

  const elements = [];
  const rawElements = Array.isArray(ir?.elements) ? ir.elements : [];
  if (!rawElements.length) errors.push('没有识别到任何元件');

  rawElements.forEach((element, index) => {
    const id = String(element?.id || '').trim() || `E${index + 1}`;
    const type = normalizeType(element?.type);
    if (!type) {
      errors.push(`元件 ${id} 的类型无法识别：${element?.type || '空'}`);
      return;
    }
    const from = String(element?.from || '').trim();
    const to = String(element?.to || '').trim();
    if (!from || !to) {
      errors.push(`元件 ${id} 缺少连接端点`);
      return;
    }
    if (!nodesById.has(from) || !nodesById.has(to)) {
      errors.push(`元件 ${id} 连接到了不存在的节点（${from} / ${to}）`);
      return;
    }
    if (type === 'voltmeter') {
      assumptions.push(`电压表 ${id} 按理想电压表处理（视为开路，不参与计算）`);
      return;
    }
    const normalized = {
      id,
      label: String(element?.label || id),
      type,
      from,
      to,
      state: String(element?.state || 'closed') === 'open' ? 'open' : 'closed',
      direction: String(element?.direction || 'from') === 'to' ? 'to' : 'from',
    };
    const value = normalizeValue({ ...element, type });
    normalized.value = value.value;
    normalized.unit = element?.unit || (type === 'resistor' ? 'Ω' : type === 'voltage_source' ? 'V' : 'A');
    if (['resistor', 'voltage_source', 'current_source'].includes(type)) {
      if (!Number.isFinite(value.value)) {
        errors.push(`元件 ${id} 的数值无法识别：${element?.value ?? '空'}`);
        return;
      }
    }
    if (type === 'switch' && normalized.state === 'open') {
      assumptions.push(`开关 ${id} 断开，按开路处理`);
      return;
    }
    if (type === 'capacitor') {
      assumptions.push(`电容 ${id} 在直流稳态下按开路处理`);
      return;
    }
    elements.push(normalized);
  });

  const uf = createUnionFind([...nodesById.keys()]);
  elements.forEach((element) => {
    const short = (element.type === 'resistor' && Math.abs(element.value) <= 1e-9)
      || element.type === 'wire'
      || element.type === 'ammeter'
      || element.type === 'inductor'
      || (element.type === 'switch' && element.state === 'closed')
      || (element.type === 'voltage_source' && Math.abs(element.value) <= 1e-9);
    if (short) {
      uf.union(element.from, element.to);
      if (element.type === 'resistor' && Math.abs(element.value) <= 1e-9) {
        assumptions.push(`电阻 ${element.id} 为 0Ω，按导线处理`);
      }
      if (element.type === 'inductor') assumptions.push(`电感 ${element.id} 在直流稳态下按短路处理`);
      if (element.type === 'voltage_source') assumptions.push(`电压源 ${element.id} 为 0V，按短路处理`);
    }
  });

  const groups = new Map();
  [...nodesById.keys()].forEach((id) => {
    const root = uf.find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  });
  const canonical = new Map();
  groups.forEach((members, root) => {
    const label = members.map((id) => nodesById.get(id)?.label).filter(Boolean).join('/');
    members.forEach((id) => canonical.set(id, root));
    nodesById.set(root, { id: root, label: dominantLabel(root, nodesById) || label });
  });

  const reduced = [];
  elements.forEach((element) => {
    if (['wire', 'ammeter', 'inductor'].includes(element.type) || element.type === 'switch') return;
    if (element.type === 'resistor' && Math.abs(element.value) <= 1e-9) return;
    if (element.type === 'voltage_source' && Math.abs(element.value) <= 1e-9) return;
    const from = canonical.get(element.from);
    const to = canonical.get(element.to);
    if (from === to) return;
    reduced.push({ ...element, from, to });
  });

  const activeNodes = new Set();
  reduced.forEach((element) => {
    activeNodes.add(element.from);
    activeNodes.add(element.to);
  });

  return { errors, warnings, assumptions, nodesById, canonical, elements: reduced, activeNodes };
}

/* ---------------------------------------------------------------- 线性方程 */

function solveLinear(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, index) => [...row, rhs[index]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const temp = a[pivot];
      a[pivot] = a[col];
      a[col] = temp;
    }
    const base = a[col][col];
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row][col] / base;
      if (!factor) continue;
      for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = a[row][n];
    for (let col = row + 1; col < n; col += 1) sum -= a[row][col] * x[col];
    x[row] = sum / a[row][row];
  }
  return x;
}

/**
 * 节点电压法。ground 必须是 activeNodes 里的节点。
 * 返回 { ok, voltages: Map, sourceCurrents: Map, error }
 */
function solveNetwork(elements, activeNodes, ground) {
  const nodeList = [...activeNodes].filter((id) => id !== ground);
  const nodeIndex = new Map(nodeList.map((id, index) => [id, index]));
  const voltageSources = elements.filter((element) => element.type === 'voltage_source');
  const size = nodeList.length + voltageSources.length;
  if (size === 0) return { ok: true, voltages: new Map([[ground, 0]]), sourceCurrents: new Map() };

  const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
  const rhs = new Array(size).fill(0);
  const stamp = (row, col, value) => {
    if (row < 0 || col < 0) return;
    matrix[row][col] += value;
  };

  elements.forEach((element) => {
    if (element.type !== 'resistor') return;
    const g = 1 / element.value;
    const a = nodeIndex.has(element.from) ? nodeIndex.get(element.from) : -1;
    const b = nodeIndex.has(element.to) ? nodeIndex.get(element.to) : -1;
    stamp(a, a, g);
    stamp(b, b, g);
    stamp(a, b, -g);
    stamp(b, a, -g);
  });

  elements.forEach((element) => {
    if (element.type !== 'current_source') return;
    // 约定：电流在元件内部从 from 流向 to，因此 from 节点流出、to 节点流入
    const value = element.direction === 'to' ? -element.value : element.value;
    const from = nodeIndex.has(element.from) ? nodeIndex.get(element.from) : -1;
    const to = nodeIndex.has(element.to) ? nodeIndex.get(element.to) : -1;
    if (from >= 0) rhs[from] -= value;
    if (to >= 0) rhs[to] += value;
  });

  voltageSources.forEach((source, index) => {
    const row = nodeList.length + index;
    const a = nodeIndex.has(source.from) ? nodeIndex.get(source.from) : -1;
    const b = nodeIndex.has(source.to) ? nodeIndex.get(source.to) : -1;
    const fromSign = a >= 0 ? 1 : -1;
    const toSign = b >= 0 ? 1 : -1;
    stamp(a, row, fromSign);
    stamp(b, row, toSign);
    stamp(row, a, fromSign);
    stamp(row, b, toSign);
    rhs[row] = source.value * fromSign;
  });

  const solution = solveLinear(matrix, rhs);
  if (!solution) {
    return { ok: false, error: '电路无法求解：可能存在理想电压源并联冲突，或缺少参考节点（请检查连线）' };
  }

  const voltages = new Map([[ground, 0]]);
  nodeList.forEach((id, index) => voltages.set(id, solution[index]));
  const sourceCurrents = new Map();
  voltageSources.forEach((source, index) => {
    sourceCurrents.set(source.id, solution[nodeList.length + index]);
  });
  return { ok: true, voltages, sourceCurrents };
}

/* ------------------------------------------------------------ 串并联化简 */

function passiveReduction(resistors, portNodes, context = {}) {
  const steps = [];
  let list = resistors.map((item) => ({ ...item }));
  let guard = 0;
  const baseElements = (context.baseElements || []).map((item) => ({ ...item }));
  const baseNodes = (context.nodes || []).map((item) => ({ id: item.id, label: item.label || item.id }));

  /**
   * 每一步都带一张快照：节点仍用原始节点表，位置因此不会在相邻步骤间跳动；
   * 元件只保留该步之后的拓扑，highlight 标出这一步新产生的等效元件。
   */
  const withDiagram = (step, highlight = [], syntheticNodes = []) => ({
    ...step,
    diagram: {
      kind: 'circuit',
      nodes: baseNodes,
      elements: [...baseElements, ...list].map((item) => ({ ...item })),
      highlight,
      syntheticNodes,
      port: null,
    },
  });

  const mergeSeries = () => {
    for (let index = 0; index < list.length; index += 1) {
      const element = list[index];
      for (const node of [element.from, element.to]) {
        if (portNodes.has(node)) continue;
        const touching = list.filter((item) => item.from === node || item.to === node);
        if (touching.length !== 2) continue;
        const [first, second] = touching;
        if (first.id === second.id) continue;
        const otherOf = (item) => (item.from === node ? item.to : item.from);
        const total = first.value + second.value;
        const merged = {
          id: `${first.id}+${second.id}`,
          label: `${first.label}与${second.label}`,
          type: 'resistor',
          value: round(total),
          unit: 'Ω',
          from: otherOf(first),
          to: otherOf(second),
          mergedIds: [...(first.mergedIds || [first.id]), ...(second.mergedIds || [second.id])],
        };
        const step = {
          title: `串联：${first.label} + ${second.label}`,
          detail: `${first.label}=${formatNumber(first.value, 'Ω')} 与 ${second.label}=${formatNumber(second.value, 'Ω')} 在节点 ${node} 处串联`,
          formula: `R = R₁ + R₂ = ${formatNumber(first.value)} + ${formatNumber(second.value)}`,
          value: formatNumber(total, 'Ω'),
        };
        list = list.filter((item) => item.id !== first.id && item.id !== second.id);
        list.push(merged);
        steps.push(withDiagram(step, [merged.id]));
        return true;
      }
    }
    return false;
  };

  const mergeParallel = () => {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const same = (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);
        if (!same) continue;
        const value = (a.value * b.value) / (a.value + b.value);
        const merged = {
          id: `${a.id}//${b.id}`,
          label: `${a.label}//${b.label}`,
          type: 'resistor',
          value: round(value),
          unit: 'Ω',
          from: a.from,
          to: a.to,
          mergedIds: [...(a.mergedIds || [a.id]), ...(b.mergedIds || [b.id])],
        };
        const step = {
          title: `并联：${a.label} ∥ ${b.label}`,
          detail: `${a.label}=${formatNumber(a.value, 'Ω')} 与 ${b.label}=${formatNumber(b.value, 'Ω')} 接在同一对节点 ${a.from}–${a.to} 之间`,
          formula: `R = R₁R₂ / (R₁ + R₂) = ${formatNumber(a.value)}×${formatNumber(b.value)} / (${formatNumber(a.value)}+${formatNumber(b.value)})`,
          value: formatNumber(value, 'Ω'),
        };
        list = list.filter((item) => item.id !== a.id && item.id !== b.id);
        list.push(merged);
        steps.push(withDiagram(step, [merged.id]));
        return true;
      }
    }
    return false;
  };

  /** 星三角：三个节点两两之间各有一个电阻，转换为 Y 形（中心节点为新节点） */
  const convertDelta = () => {
    const pairMap = new Map();
    list.forEach((item) => {
      const key = [item.from, item.to].sort().join('|');
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key).push(item);
    });
    const nodes = [...new Set(list.flatMap((item) => [item.from, item.to]))];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        for (let k = j + 1; k < nodes.length; k += 1) {
          const ids = [nodes[i], nodes[j], nodes[k]];
          const edges = [
            pairMap.get([ids[0], ids[1]].sort().join('|')),
            pairMap.get([ids[1], ids[2]].sort().join('|')),
            pairMap.get([ids[0], ids[2]].sort().join('|')),
          ];
          if (edges.some((edge) => !edge || edge.length !== 1)) continue;
          if (ids.some((id) => portNodes.has(id))) continue;
          const [rab, rbc, rac] = [edges[0][0], edges[1][0], edges[2][0]];
          const sum = rab.value + rbc.value + rac.value;
          if (sum <= 0) continue;
          const center = `Y${guard + 1}`;
          const ra = (rab.value * rac.value) / sum;
          const rb = (rab.value * rbc.value) / sum;
          const rc = (rbc.value * rac.value) / sum;
          const step = {
            title: `星三角变换：${rab.label}/${rbc.label}/${rac.label}`,
            detail: `节点 ${ids.join('、')} 构成三角形，等效为以 ${center} 为中心的星形`,
            formula: 'R = 相邻两边之积 / 三边之和',
            value: `${formatNumber(ra, 'Ω')} / ${formatNumber(rb, 'Ω')} / ${formatNumber(rc, 'Ω')}`,
          };
          list = list.filter((item) => ![rab.id, rbc.id, rac.id].includes(item.id));
          list.push({ id: `${center}a`, label: `${center}a`, type: 'resistor', value: round(ra), unit: 'Ω', from: ids[0], to: center });
          list.push({ id: `${center}b`, label: `${center}b`, type: 'resistor', value: round(rb), unit: 'Ω', from: ids[1], to: center });
          list.push({ id: `${center}c`, label: `${center}c`, type: 'resistor', value: round(rc), unit: 'Ω', from: ids[2], to: center });
          steps.push(withDiagram(step, [`${center}a`, `${center}b`, `${center}c`], [{ id: center, anchors: ids.slice() }]));
          return true;
        }
      }
    }
    return false;
  };

  while (guard < 40) {
    guard += 1;
    if (mergeSeries()) continue;
    if (mergeParallel()) continue;
    if (convertDelta()) continue;
    break;
  }

  return { resistors: list, steps };
}

/** 分压 / 分流：只在真正的串联（共用一个节点且另一端点不同）上给比例，数值来自求解结果 */
function dividerSteps(elements, nodeVoltages) {
  const steps = [];
  const seen = new Set();
  const resistors = elements.filter((element) => element.type === 'resistor');
  const degree = new Map();
  resistors.forEach((element) => {
    degree.set(element.from, (degree.get(element.from) || 0) + 1);
    degree.set(element.to, (degree.get(element.to) || 0) + 1);
  });
  const sameEnds = (a, b) => (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);
  resistors.forEach((element) => {
    for (const node of [element.from, element.to]) {
      if ((degree.get(node) || 0) !== 2) continue;
      const neighbor = resistors.find((item) => item.id !== element.id
        && (item.from === node || item.to === node)
        && !sameEnds(item, element));
      if (!neighbor) continue;
      const key = [element.id, neighbor.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const u1 = nodeVoltages.get(element.from) - nodeVoltages.get(element.to);
      const u2 = nodeVoltages.get(neighbor.from) - nodeVoltages.get(neighbor.to);
      if (!Number.isFinite(u1) || !Number.isFinite(u2)) continue;
      steps.push({
        title: `分压：${element.label} / ${neighbor.label}`,
        detail: `两者在节点 ${node} 处串联，电压按电阻比例分配`,
        formula: `U₁ : U₂ = R₁ : R₂ = ${formatNumber(element.value)} : ${formatNumber(neighbor.value)}`,
        value: `${formatNumber(Math.abs(u1), 'V')} : ${formatNumber(Math.abs(u2), 'V')}`,
      });
      break;
    }
  });
  return steps;
}

/* ------------------------------------------------------------------ 求解 */

function emptyResult(errors = []) {
  return {
    ok: false,
    errors,
    warnings: [],
    assumptions: [],
    steps: [],
    nodeVoltages: [],
    elements: [],
    port: null,
    summary: [],
    needsClarification: false,
    ambiguities: [],
  };
}

function pickGround(prepared, preferred) {
  if (preferred && prepared.activeNodes.has(preferred)) return preferred;
  let best = '';
  let bestDegree = -1;
  const degree = new Map();
  prepared.elements.forEach((element) => {
    for (const node of [element.from, element.to]) {
      degree.set(node, (degree.get(node) || 0) + 1);
    }
  });
  prepared.activeNodes.forEach((node) => {
    const value = degree.get(node) || 0;
    if (value > bestDegree) {
      best = node;
      bestDegree = value;
    }
  });
  return best;
}

/**
 * 求解主入口。
 * @param {object} ir 结构化中间表示
 * @param {{ ignoreAmbiguities?: boolean }} options
 */
function solveCircuit(ir, options = {}) {
  const ambiguities = Array.isArray(ir?.ambiguities) ? ir.ambiguities.filter((item) => item?.question) : [];
  if (ambiguities.length && !options.ignoreAmbiguities) {
    const result = emptyResult();
    result.needsClarification = true;
    result.ambiguities = ambiguities;
    result.errors = ['读图存在歧义，请先确认下面的问题，确认后再计算'];
    return result;
  }

  const prepared = prepareTopology(ir || {});
  if (prepared.errors.length) {
    const result = emptyResult(prepared.errors);
    result.assumptions = prepared.assumptions;
    return result;
  }
  if (!prepared.activeNodes.size) {
    return emptyResult(['整理后没有可计算的支路，请检查元件连接']);
  }

  // 连通性：MNA 只对单个连通网络有唯一解
  const parent = new Map([...prepared.activeNodes].map((id) => [id, id]));
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  };
  prepared.elements.forEach((element) => {
    const a = find(element.from);
    const b = find(element.to);
    if (a !== b) parent.set(a, b);
  });
  const roots = new Set([...prepared.activeNodes].map((id) => find(id)));
  if (roots.size > 1) {
    return {
      ...emptyResult(['电路不连通：有元件没有接到电源回路上，请检查连线']),
      assumptions: prepared.assumptions,
    };
  }

  const port = ir?.port && ir.port.plus && ir.port.minus
    ? {
      plus: prepared.canonical.get(String(ir.port.plus)) || String(ir.port.plus),
      minus: prepared.canonical.get(String(ir.port.minus)) || String(ir.port.minus),
    }
    : null;

  const ground = pickGround(prepared, port?.minus || '');
  const solved = solveNetwork(prepared.elements, prepared.activeNodes, ground);
  if (!solved.ok) {
    return { ...emptyResult([solved.error]), assumptions: prepared.assumptions };
  }

  const warnings = [...prepared.warnings];
  const assumptions = [...prepared.assumptions];

  const nodeVoltages = [...prepared.activeNodes]
    .map((id) => ({
      node: id,
      label: prepared.nodesById.get(id)?.label || id,
      voltage: round(solved.voltages.get(id) || 0),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));

  const elementResults = prepared.elements.map((element) => {
    const ua = solved.voltages.get(element.from) || 0;
    const ub = solved.voltages.get(element.to) || 0;
    let current = 0;
    let voltage = ua - ub;
    if (element.type === 'resistor') current = (ua - ub) / element.value;
    else if (element.type === 'voltage_source') {
      voltage = element.value;
      current = solved.sourceCurrents.get(element.id) || 0;
    } else if (element.type === 'current_source') {
      current = element.value;
      voltage = ua - ub;
    }
    return {
      id: element.id,
      label: element.label,
      type: element.type,
      value: round(element.value),
      unit: element.unit,
      from: element.from,
      to: element.to,
      voltage: round(voltage),
      current: round(current),
      power: round(Math.abs(voltage * current)),
    };
  });

  const steps = [];
  const resistors = prepared.elements.filter((element) => element.type === 'resistor');
  const portNodes = new Set(port ? [port.plus, port.minus] : []);
  if (resistors.length >= 2) {
    const reduced = passiveReduction(resistors, portNodes, {
      baseElements: prepared.elements.filter((element) => element.type !== 'resistor'),
      nodes: [...prepared.nodesById.values()],
    });
    steps.push(...reduced.steps);
  }
  steps.push(...dividerSteps(prepared.elements, solved.voltages));

  let portResult = null;
  if (port) {
    if (port.plus === port.minus) {
      portResult = { plus: port.plus, minus: port.minus, req: 0, uoc: 0, isc: 0, note: '端口两端被导线短接' };
    } else {
      // 戴维南：开路电压
      const uoc = round((solved.voltages.get(port.plus) || 0) - (solved.voltages.get(port.minus) || 0));

      // 短路电流：端口之间加 0V 电压源，读该电压源电流
      const probeId = '__port_short__';
      const withShort = [...prepared.elements, {
        id: probeId, label: probeId, type: 'voltage_source', value: 0, unit: 'V',
        from: port.plus, to: port.minus, direction: 'from', state: 'closed',
      }];
      const shortSolved = solveNetwork(withShort, prepared.activeNodes, ground);
      let isc = NaN;
      let req = NaN;
      let note = '';
      if (shortSolved.ok) {
        isc = round(shortSolved.sourceCurrents.get(probeId) || 0);
        if (Math.abs(uoc) > 1e-9 && Math.abs(isc) > 1e-9) {
          req = round(uoc / isc);
          if (req < 0) {
            note = '等效电阻为负，说明端口方向与电流参考方向不一致，请核对端口标注';
            req = Math.abs(req);
          }
        }
      }

      // 等效电阻：独立源置零（电压源短路、电流源开路），端口注入 1A
      // 注意：电压源要「并点」而不是简单删除，否则等效电阻会算大。
      const deactivate = createUnionFind([...prepared.activeNodes]);
      prepared.elements.forEach((element) => {
        if (element.type === 'voltage_source') deactivate.union(element.from, element.to);
      });
      const mapNode = (id) => deactivate.find(id);
      const passive = prepared.elements
        .filter((element) => element.type === 'resistor')
        .map((element) => ({ ...element, from: mapNode(element.from), to: mapNode(element.to) }))
        .filter((element) => element.from !== element.to);
      const plus = mapNode(port.plus);
      const minus = mapNode(port.minus);
      let reqByInjection = NaN;
      if (plus === minus) {
        reqByInjection = 0;
        note = '端口被理想电压源 / 导线直接短接，等效电阻为 0';
      } else {
        // 只取端口 plus 所在的连通块，避免悬空支路让方程奇异
        const adjacency = new Map();
        passive.forEach((element) => {
          if (!adjacency.has(element.from)) adjacency.set(element.from, []);
          if (!adjacency.has(element.to)) adjacency.set(element.to, []);
          adjacency.get(element.from).push(element.to);
          adjacency.get(element.to).push(element.from);
        });
        const component = new Set([plus]);
        const queue = [plus];
        while (queue.length) {
          const node = queue.shift();
          (adjacency.get(node) || []).forEach((next) => {
            if (!component.has(next)) {
              component.add(next);
              queue.push(next);
            }
          });
        }
        if (!component.has(minus)) {
          note = '端口之间没有直流通路，等效电阻视为无穷大';
        } else {
          const inject = [...passive.filter((element) => component.has(element.from) && component.has(element.to)), {
            id: '__port_test__', label: '__port_test__', type: 'current_source', value: 1, unit: 'A',
            from: minus, to: plus, direction: 'from', state: 'closed',
          }];
          const injected = solveNetwork(inject, component, minus);
          if (injected.ok) {
            reqByInjection = round((injected.voltages.get(plus) || 0) - (injected.voltages.get(minus) || 0));
          }
        }
      }
      if (!Number.isFinite(req) && Number.isFinite(reqByInjection)) req = reqByInjection;
      if (reqByInjection === 0) req = 0;

      portResult = {
        plus: port.plus,
        minus: port.minus,
        uoc,
        isc: Number.isFinite(isc) ? isc : null,
        req: Number.isFinite(req) ? req : null,
        reqByInjection: Number.isFinite(reqByInjection) ? reqByInjection : null,
        note,
      };

      steps.push({
        title: '等效电源（戴维南 / 诺顿）',
        detail: `以端口 ${port.plus}–${port.minus} 为输出端，先求开路电压，再用短路电流求内阻`,
        formula: 'U_oc = 开路电压；I_sc = 短路电流；R_eq = U_oc / I_sc',
        value: `U_oc=${formatNumber(uoc, 'V')}${Number.isFinite(isc) ? `，I_sc=${formatNumber(isc, 'A')}` : ''}${Number.isFinite(req) ? `，R_eq=${formatNumber(req, 'Ω')}` : ''}`,
      });
      if (Number.isFinite(reqByInjection)) {
        steps.push({
          title: '等效电阻校核（1A 注入法）',
          detail: '把独立源置零后，在端口注入 1A 测试电流，端口电压在数值上等于等效电阻',
          formula: 'R_eq = U_port / 1A',
          value: formatNumber(reqByInjection, 'Ω'),
        });
      }
    }
  }

  const summary = [];
  if (portResult) {
    summary.push(`端口 ${portResult.plus}–${portResult.minus}：`
      + `U_oc=${formatNumber(portResult.uoc, 'V')}`
      + `${Number.isFinite(portResult.req) ? `，R_eq=${formatNumber(portResult.req, 'Ω')}` : ''}`);
  }

  return {
    ok: true,
    errors: [],
    warnings,
    assumptions,
    steps,
    nodeVoltages,
    elements: elementResults,
    port: portResult,
    summary,
    needsClarification: false,
    ambiguities: [],
    topology: {
      nodes: nodeVoltages.length,
      elements: elementResults.length,
      ground,
    },
  };
}

module.exports = {
  solveCircuit,
  formatNumber,
  round,
  normalizeType,
};
