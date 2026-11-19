'use strict';
/**
 * 单线图（母线-支路）确定性计算：辐射状网络的下游负荷累加 + 线路压降。
 *
 * 只做「代码能确定算」的部分：
 *   - 三相系统，S = √3 · U · I；
 *   - 辐射状（树形）网络：环网直接报不支持，不做近似；
 *   - 变压器只做变比折算，未给阻抗时不虚构阻抗（明确写进假设）；
 *   - 负荷缺功率因数时按 0.9 计算并注明。
 *
 * IR：
 * {
 *   kind: 'one-line',
 *   buses: [{ id, label, voltage, unit }],
 *   sources: [{ id, label, bus, voltage, unit }],
 *   branches: [{ id, label, type: 'line'|'transformer', from, to,
 *                r, x, unit, length, rPerKm, xPerKm, ratio }],
 *   loads: [{ id, label, bus, p, unit, pf }],
 *   ambiguities: [{ question, options }]
 * }
 */

const { formatNumber, round } = require('./circuitSolver.js');

const P_UNITS = { W: 1e-3, kW: 1, MW: 1e3, '千瓦': 1, '兆瓦': 1e3 };
const U_UNITS = { V: 1e-3, kV: 1, '千伏': 1, '伏': 1e-3 };

function numberOrNaN(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw ?? '').trim().replace(/,/g, '');
  if (!text) return NaN;
  const value = Number(text);
  return Number.isFinite(value) ? value : NaN;
}

function toKW(value, unit) {
  return value * (P_UNITS[unit] || 1);
}

function toKV(value, unit) {
  return value * (U_UNITS[unit] || 1);
}

/** "10/0.4" → 0.04（二次侧 / 一次侧） */
function parseRatio(raw) {
  const match = /^\s*([\d.]+)\s*[/:：]\s*([\d.]+)\s*$/.exec(String(raw || ''));
  if (!match) return NaN;
  const primary = Number(match[1]);
  const secondary = Number(match[2]);
  if (!primary || !secondary) return NaN;
  return secondary / primary;
}

function emptyFailure(errors) {
  return {
    ok: false,
    errors,
    warnings: [],
    assumptions: [],
    steps: [],
    buses: [],
    branches: [],
    loads: [],
    summary: [],
    needsClarification: false,
    ambiguities: [],
  };
}

function solveOneLine(ir, options = {}) {
  const ambiguities = Array.isArray(ir?.ambiguities) ? ir.ambiguities.filter((item) => item?.question) : [];
  if (ambiguities.length && !options.ignoreAmbiguities) {
    return {
      ...emptyFailure(['读图存在歧义，请先确认下面的问题，确认后再计算']),
      needsClarification: true,
      ambiguities,
    };
  }

  const errors = [];
  const warnings = [];
  const assumptions = [];

  const buses = Array.isArray(ir?.buses) ? ir.buses : [];
  const busMap = new Map();
  buses.forEach((bus, index) => {
    const id = String(bus?.id || '').trim();
    if (!id) {
      errors.push(`第 ${index + 1} 条母线缺少 id`);
      return;
    }
    busMap.set(id, {
      id,
      label: String(bus.label || id),
      voltage: toKV(numberOrNaN(bus.voltage), bus.unit || 'kV'),
    });
  });
  if (!busMap.size) errors.push('没有识别到母线');

  const sources = (Array.isArray(ir?.sources) ? ir.sources : []).map((source, index) => {
    const id = String(source?.id || `G${index + 1}`);
    const bus = String(source?.bus || '').trim();
    const voltage = toKV(numberOrNaN(source.voltage), source.unit || 'kV');
    if (!busMap.has(bus)) errors.push(`电源 ${id} 接在未知母线上：${bus || '空'}`);
    if (!Number.isFinite(voltage)) errors.push(`电源 ${id} 的电压无法识别`);
    return { id, label: String(source.label || id), bus, voltage };
  });
  if (!sources.length) errors.push('没有识别到电源');

  const branches = (Array.isArray(ir?.branches) ? ir.branches : []).map((branch, index) => {
    const id = String(branch?.id || `B${index + 1}`);
    const type = String(branch?.type || '').toLowerCase() === 'transformer' || branch?.ratio ? 'transformer' : 'line';
    const from = String(branch?.from || '').trim();
    const to = String(branch?.to || '').trim();
    if (!busMap.has(from) || !busMap.has(to)) {
      errors.push(`支路 ${id} 连接到了不存在的母线（${from || '空'} / ${to || '空'}）`);
    }
    let r = numberOrNaN(branch.r);
    let x = numberOrNaN(branch.x);
    const length = numberOrNaN(branch.length);
    if (!Number.isFinite(r) && Number.isFinite(branch.rPerKm) && Number.isFinite(length)) {
      r = numberOrNaN(branch.rPerKm) * length;
    }
    if (!Number.isFinite(x) && Number.isFinite(branch.xPerKm) && Number.isFinite(length)) {
      x = numberOrNaN(branch.xPerKm) * length;
    }
    const ratio = type === 'transformer' ? parseRatio(branch.ratio) : 1;
    if (type === 'transformer' && !Number.isFinite(ratio)) {
      errors.push(`变压器 ${id} 的变比无法识别：${branch.ratio || '空'}（应形如 10/0.4）`);
    }
    return {
      id,
      label: String(branch.label || id),
      type,
      from,
      to,
      r: Number.isFinite(r) ? r : 0,
      x: Number.isFinite(x) ? x : 0,
      ratio,
      hasImpedance: type === 'transformer' ? false : Number.isFinite(r) || Number.isFinite(x),
    };
  });
  if (!branches.length) errors.push('没有识别到线路 / 变压器支路');

  const loads = (Array.isArray(ir?.loads) ? ir.loads : []).map((load, index) => {
    const id = String(load?.id || `L${index + 1}`);
    const bus = String(load?.bus || '').trim();
    const p = toKW(numberOrNaN(load.p), load.unit || 'kW');
    const pf = Number(load.pf);
    if (!busMap.has(bus)) errors.push(`负荷 ${id} 接在未知母线上：${bus || '空'}`);
    if (!Number.isFinite(p)) errors.push(`负荷 ${id} 的功率无法识别`);
    const powerFactor = Number.isFinite(pf) && pf > 0 && pf <= 1 ? pf : 0.9;
    if (!Number.isFinite(pf) || pf <= 0 || pf > 1) {
      assumptions.push(`负荷 ${id} 未给出有效功率因数，按 0.9 计算`);
    }
    return {
      id,
      label: String(load.label || id),
      bus,
      p,
      q: Math.abs(p) * Math.tan(Math.acos(powerFactor)),
      pf: powerFactor,
    };
  });

  if (errors.length) return { ...emptyFailure(errors), assumptions };

  /* 拓扑：必须是一棵以电源为根的树 */
  const adjacency = new Map([...busMap.keys()].map((id) => [id, []]));
  branches.forEach((branch) => {
    adjacency.get(branch.from).push({ to: branch.to, branch });
    adjacency.get(branch.to).push({ to: branch.from, branch });
  });

  const visited = new Set();
  const parent = new Map();
  const order = [];
  const root = sources[0].bus;
  const queue = [root];
  visited.add(root);
  while (queue.length) {
    const node = queue.shift();
    order.push(node);
    const neighbors = adjacency.get(node) || [];
    neighbors.forEach(({ to, branch }) => {
      if (!visited.has(to)) {
        visited.add(to);
        parent.set(to, { node, branch });
        queue.push(to);
      } else if (parent.get(node)?.node !== to && parent.get(to)?.node !== node) {
        // 访问到已经入队的节点，说明存在环
        warnings.push(`检测到环网（${node}–${to}），辐射状计算无法唯一确定潮流`);
      }
    });
  }
  if (visited.size !== busMap.size) {
    const isolated = [...busMap.keys()].filter((id) => !visited.has(id));
    return {
      ...emptyFailure([`有母线没有与电源连通：${isolated.map((id) => busMap.get(id).label).join('、')}`]),
      assumptions,
    };
  }
  if (warnings.some((text) => text.includes('环网'))) {
    return {
      ...emptyFailure(['当前单线图引擎只支持辐射状网络；检测到环网，请先确认拓扑或改用其它分析方法']),
      warnings,
      assumptions,
    };
  }

  /* 母线电压：从电源出发，线路按压降递减，变压器按变比折算 */
  const voltages = new Map([[root, sources[0].voltage]]);
  [...order].forEach((node) => {
    if (node === root) return;
    const info = parent.get(node);
    if (!info) return;
    const upstream = voltages.get(info.node) || busMap.get(info.node).voltage || 0;
    if (info.branch.type === 'transformer') {
      voltages.set(node, upstream * info.branch.ratio);
      assumptions.push(`变压器 ${info.branch.label} 未给短路阻抗，按理想变压器（仅变比折算、无压降）处理`);
    } else {
      voltages.set(node, busMap.get(node).voltage > 0 ? Math.min(busMap.get(node).voltage, upstream) : upstream);
    }
  });

  /* 下游负荷累加：后序 */
  const downstream = new Map([...busMap.keys()].map((id) => [id, { p: 0, q: 0 }]));
  [...order].reverse().forEach((node) => {
    const own = loads.filter((load) => load.bus === node);
    const total = own.reduce((sum, load) => ({
      p: sum.p + load.p,
      q: sum.q + load.q,
    }), downstream.get(node));
    downstream.set(node, total);
    const info = parent.get(node);
    if (info) {
      const upstream = downstream.get(info.node);
      downstream.set(info.node, { p: upstream.p + total.p, q: upstream.q + total.q });
    }
  });

  const steps = [];
  const branchResults = [];
  // 按树的先序（BFS 顺序）算，父母线电压一定已经算好，避免依赖 branches 的书写顺序
  order.forEach((node) => {
    if (node === root) return;
    const info = parent.get(node);
    if (!info) return;
    const branch = info.branch;
    const parentNode = info.node;
    const child = node;
    const load = downstream.get(child);
    const voltage = voltages.get(parentNode) || 0;
    const apparent = Math.sqrt(load.p ** 2 + load.q ** 2);
    const current = voltage > 0 ? apparent / (Math.sqrt(3) * voltage) : NaN;
    let drop = 0;
    let toVoltage = voltages.get(child) || 0;
    if (branch.type === 'line' && voltage > 0 && Number.isFinite(current)) {
      const cosPhi = apparent > 0 ? load.p / apparent : 1;
      const sinPhi = apparent > 0 ? load.q / apparent : 0;
      // drop 以 V 计，母线电压以 kV 计
      drop = Math.sqrt(3) * current * (branch.r * cosPhi + branch.x * sinPhi);
      toVoltage = Math.max(0, voltage - drop / 1000);
      voltages.set(child, toVoltage);
    } else if (branch.type === 'transformer') {
      toVoltage = voltage * branch.ratio;
      voltages.set(child, toVoltage);
    }
    steps.push({
      title: `${branch.type === 'transformer' ? '变压器' : '线路'} ${branch.label}`,
      detail: `${busMap.get(parentNode).label} → ${busMap.get(child).label}，下游有功 ${formatNumber(load.p, 'kW')}、无功 ${formatNumber(load.q, 'kvar')}`,
      formula: branch.type === 'transformer'
        ? 'I = S / (√3·U)，按变比折算二次侧电压'
        : 'I = S / (√3·U)；ΔU = √3·I·(R·cosφ + X·sinφ)',
      value: `I=${formatNumber(current, 'A')}${branch.type === 'line' ? `，ΔU=${formatNumber(drop, 'V')}` : ''}`,
    });
    branchResults.push({
      id: branch.id,
      label: branch.label,
      type: branch.type,
      from: parentNode,
      to: child,
      downstreamP: round(load.p),
      downstreamQ: round(load.q),
      current: round(current),
      drop: round(drop),
      fromVoltage: round(voltage),
      toVoltage: round(toVoltage),
    });
  });

  const totalP = loads.reduce((sum, load) => sum + load.p, 0);
  const totalQ = loads.reduce((sum, load) => sum + load.q, 0);
  const sourceCurrent = sources[0].voltage > 0
    ? Math.sqrt(totalP ** 2 + totalQ ** 2) / (Math.sqrt(3) * sources[0].voltage)
    : NaN;

  steps.unshift({
    title: '负荷汇总',
    detail: `共 ${loads.length} 个负荷，接在 ${new Set(loads.map((load) => load.bus)).size} 条母线上`,
    formula: 'P = ΣP，Q = Σ(P·tanφ)',
    value: `P=${formatNumber(totalP, 'kW')}，Q=${formatNumber(totalQ, 'kvar')}`,
  });

  assumptions.unshift('按三相对称系统计算，母线电压为线电压有效值');

  return {
    ok: true,
    errors: [],
    warnings,
    assumptions,
    steps,
    buses: [...busMap.values()].map((bus) => ({
      id: bus.id,
      label: bus.label,
      voltage: round(voltages.get(bus.id)),
      nominal: round(bus.voltage),
    })),
    branches: branchResults,
    loads: loads.map((load) => ({ id: load.id, label: load.label, bus: load.bus, p: round(load.p), q: round(load.q), pf: load.pf })),
    summary: [
      `总负荷：${formatNumber(totalP, 'kW')}，功率因数 ${formatNumber(totalP / (Math.sqrt(totalP ** 2 + totalQ ** 2) || 1))}`,
      `电源侧电流：${formatNumber(sourceCurrent, 'A')}`,
    ],
    needsClarification: false,
    ambiguities: [],
  };
}

module.exports = { solveOneLine, parseRatio };
