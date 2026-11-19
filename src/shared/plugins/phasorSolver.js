'use strict';
/**
 * 相量图数据（确定性部分）。
 *
 * 两种模式：
 *   given        —— 题目给出具体电压 / 电流复数，只做校验、单位归一与直角坐标换算；
 *   qualitative  —— 定性分析题（没有具体数值，如「增加有功、保持无功不变，画 E0 / I 的轨迹」），
 *                   由内置的电机分析套路给出归一化示意相量、端点轨迹和分步图。
 *
 * 定性模式只表达相对大小、相位与轨迹，图中数值是归一化示意值，不代表题目数值；
 * 结论（E0、θ、I、φ、cosφ 如何变化）来自固定分析表，不由模型自由发挥。
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

/* ------------------------------------------------------------ 定性分析模板 */

const BASE = { U: 1, XS: 1, E0: 1.58, THETA0: 30 };

const MACHINE_ALIASES = {
  'cylindrical-sync-generator': 'cylindrical-sync-generator',
  'cylindrical-synchronous-generator': 'cylindrical-sync-generator',
  'non-salient-sync-generator': 'cylindrical-sync-generator',
  'non-salient-pole-sync-generator': 'cylindrical-sync-generator',
  'sync-generator': 'cylindrical-sync-generator',
  '同步发电机': 'cylindrical-sync-generator',
  '隐极同步发电机': 'cylindrical-sync-generator',
  '隐极机': 'cylindrical-sync-generator',
};

const MACHINE_LABELS = {
  'cylindrical-sync-generator': '隐极同步发电机（并联大电网）',
};

const CHANGE_ALIASES = {
  active: 'active',
  'active-power': 'active',
  p: 'active',
  '有功': 'active',
  '有功功率': 'active',
  reactive: 'reactive',
  'reactive-power': 'reactive',
  q: 'reactive',
  '无功': 'reactive',
  '无功功率': 'reactive',
  excitation: 'excitation',
  'excitation-current': 'excitation',
  field: 'excitation',
  if: 'excitation',
  '励磁': 'excitation',
  '励磁电流': 'excitation',
};

const CHANGE_LABELS = { active: '有功功率', reactive: '无功功率', excitation: '励磁电流' };

const HOLD_ALIASES = {
  active: 'active',
  'active-power': 'active',
  p: 'active',
  '有功': 'active',
  '有功功率': 'active',
  reactive: 'reactive',
  'reactive-power': 'reactive',
  q: 'reactive',
  '无功': 'reactive',
  '无功功率': 'reactive',
  excitation: 'excitation',
  field: 'excitation',
  if: 'excitation',
  '励磁': 'excitation',
  '励磁电流': 'excitation',
};

const HOLD_LABELS = { active: '有功功率', reactive: '无功功率', excitation: '励磁电流' };

const DIRECTION_ALIASES = {
  increase: 'increase',
  up: 'increase',
  raise: 'increase',
  '增大': 'increase',
  '增加': 'increase',
  '提高': 'increase',
  decrease: 'decrease',
  down: 'decrease',
  reduce: 'decrease',
  '减小': 'decrease',
  '减少': 'decrease',
  '降低': 'decrease',
};

function normalizeToken(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

function pickAlias(aliases, raw) {
  const key = normalizeToken(raw);
  return aliases[key] || '';
}

function deg(radians) {
  return (radians * 180) / Math.PI;
}

function rad(degrees) {
  return (degrees * Math.PI) / 180;
}

/** 由 P、Q（以 U=1、X_s=1 归一化）还原相量图上各量 */
function stateFromPQ(P, Q) {
  const e0 = { x: 1 + Q, y: P };
  return stateFromE0Vector(e0);
}

function stateFromE0Vector(e0) {
  const magnitude = Math.hypot(e0.x, e0.y);
  const theta = deg(Math.atan2(e0.y, e0.x));
  const P = e0.y;
  const Q = e0.x - 1;
  const I = Math.hypot(P, Q);
  const phi = deg(Math.atan2(Q, P));
  return { e0, E0: magnitude, theta, P, Q, I, phi };
}

function vectorPhasor({ id, label, quantity, real, imag, start, dashed = false }) {
  const magnitude = Math.hypot(real, imag);
  const angle = deg(Math.atan2(imag, real));
  const item = {
    id,
    label,
    quantity,
    magnitude: round(magnitude),
    unit: '',
    angle: round(angle),
    real: round(real),
    imag: round(imag),
    source: 'illustrative',
    verified: false,
  };
  if (start) item.start = { real: round(start.real), imag: round(start.imag) };
  if (dashed) item.dashed = true;
  return item;
}

function phasorSet(state, { suffix = '', subscript = '', dashed = false } = {}) {
  return [
    vectorPhasor({ id: `U${suffix}`, label: 'U̇', quantity: 'voltage', real: BASE.U, imag: 0, dashed }),
    vectorPhasor({
      id: `I${suffix}`,
      label: `İ${subscript}`,
      quantity: 'current',
      real: state.P,
      imag: -state.Q,
      dashed,
    }),
    vectorPhasor({
      id: `IX${suffix}`,
      label: `jİ${subscript}X_s`,
      quantity: 'voltage',
      real: state.Q,
      imag: state.P,
      start: { real: BASE.U, imag: 0 },
      dashed,
    }),
    vectorPhasor({
      id: `E${suffix}`,
      label: `Ė₀${subscript}`,
      quantity: 'voltage',
      real: state.e0.x,
      imag: state.e0.y,
      dashed,
    }),
  ];
}

/** 各定性情形的端点轨迹（相量图坐标，U=1、X_s=1 归一化） */
function guidesFor(change, hold, base) {
  if (change === 'active' && hold === 'reactive') {
    return [
      { type: 'vline', x: 1 + base.Q, label: 'Ė₀ 端点轨迹：Q 不变 → 横坐标不变' },
      { type: 'hline', y: -base.Q, label: 'İ 端点轨迹：无功分量不变 → 水平线' },
    ];
  }
  if ((change === 'reactive' || change === 'excitation') && hold === 'active') {
    return [
      { type: 'hline', y: base.P, label: 'Ė₀ 端点轨迹：P 不变 → 纵坐标不变' },
      { type: 'vline', x: base.P, label: 'İ 端点轨迹：有功分量不变 → 竖直线' },
    ];
  }
  if (change === 'active' && hold === 'excitation') {
    return [
      { type: 'circle', cx: 0, cy: 0, r: base.E0, label: 'Ė₀ 端点轨迹：励磁不变 → 半径不变的圆弧' },
      { type: 'circle', cx: 0, cy: 1, r: base.E0, label: 'İ 端点轨迹：E₀ 不变 → 圆弧' },
    ];
  }
  return [];
}

/** 固定结论表：保证定性结论不随模型发挥而变 */
function conclusionsFor(change, hold, direction) {
  const up = direction === 'increase';
  if (change === 'active' && hold === 'reactive') {
    return up
      ? [
        ['Ė₀ 幅值', '增大', '$E_0^2 = (U + QX_s/U)^2 + (PX_s/U)^2$，后项随 P 增大'],
        ['功角 θ', '增大', '$\\tan\\theta = \\frac{PX_s/U}{U + QX_s/U}$，分子增大、分母不变'],
        ['İ 幅值', '增大', '有功分量增大、无功分量不变'],
        ['功率因数角 φ', '减小', '$\\tan\\varphi = Q/P$，Q 不变、P 增大'],
        ['cosφ', '提高（趋近 1）', '$\\cos\\varphi = \\frac{P}{\\sqrt{P^2+Q^2}}$，无功占比下降'],
      ]
      : [
        ['Ė₀ 幅值', '减小', '$E_0^2$ 的有功分量项随 P 减小'],
        ['功角 θ', '减小', '$\\tan\\theta$ 的分子（正比于 P）减小'],
        ['İ 幅值', '减小', '有功分量减小、无功分量不变'],
        ['功率因数角 φ', '增大', '$\\tan\\varphi = Q/P$，Q 不变、P 减小'],
        ['cosφ', '降低', '有功占比下降、无功占比上升'],
      ];
  }
  if ((change === 'reactive' || change === 'excitation') && hold === 'active') {
    return up
      ? [
        ['Ė₀ 幅值', '增大', '增大励磁电流 → 空载电动势增大'],
        ['功角 θ', '减小', '$E_0\\sin\\theta = PX_s/U$ 恒定，$E_0$ 增大则 $\\sin\\theta$ 减小'],
        ['İ 幅值', '增大', '有功分量不变、无功分量增大'],
        ['功率因数角 φ', '增大', 'Q/P 增大，电流更滞后'],
        ['cosφ', '降低', '无功占比增大'],
      ]
      : [
        ['Ė₀ 幅值', '减小', '减小励磁电流 → 空载电动势减小'],
        ['功角 θ', '增大', '$E_0\\sin\\theta = PX_s/U$ 恒定，$E_0$ 减小则 $\\sin\\theta$ 增大'],
        ['İ 幅值', '减小', '有功分量不变、无功分量减小'],
        ['功率因数角 φ', '减小', 'Q/P 减小，电流更接近单位功率因数'],
        ['cosφ', '提高', '无功占比减小'],
      ];
  }
  if (change === 'active' && hold === 'excitation') {
    return up
      ? [
        ['Ė₀ 幅值', '基本不变', '只调节原动机，励磁电流不变'],
        ['功角 θ', '增大', '$\\sin\\theta = PX_s/(E_0U)$，P 增大'],
        ['无功 Q', '减小（可能进相）', '$Q = mU(E_0\\cos\\theta - U)/X_s$，θ 增大则 $\\cos\\theta$ 减小'],
        ['İ 幅值', '先减小后增大', '有功分量增大、无功分量减小；Q 过零时 I 最小'],
        ['功率因数角 φ', '先减小，Q 过零后反向增大', '$\\varphi = \\arctan(Q/P)$'],
        ['cosφ', '先提高（趋近 1），再降低', 'Q 过零时 $\\cos\\varphi = 1$'],
      ]
      : [
        ['Ė₀ 幅值', '基本不变', '只调节原动机，励磁电流不变'],
        ['功角 θ', '减小', '$\\sin\\theta = PX_s/(E_0U)$，P 减小'],
        ['无功 Q', '增大', 'θ 减小则 $\\cos\\theta$ 增大，Q 增大'],
        ['İ 幅值', '减小', '有功、无功分量同时变化，I 减小'],
        ['功率因数角 φ', '增大', 'Q/P 增大'],
        ['cosφ', '降低', '无功占比增大'],
      ];
  }
  return [];
}

function targetState(change, hold, direction, base, level) {
  const up = direction === 'increase';
  // level 是「相对额定点的倍数」，来自工作台滑块；没有滑块时按题目要求的方向取固定示意点
  const ratio = Number.isFinite(level) ? Math.max(0.05, level) : null;
  if (change === 'active' && hold === 'reactive') {
    return stateFromPQ(base.P * (ratio ?? (up ? 1.35 : 0.7)), base.Q);
  }
  if ((change === 'reactive' || change === 'excitation') && hold === 'active') {
    return stateFromPQ(base.P, base.Q * (ratio ?? (up ? 1.6 : 0.4)));
  }
  if (change === 'active' && hold === 'excitation') {
    if (ratio != null) {
      // 励磁不变 → E₀ 恒定，改变有功等价于沿圆弧改变功角 θ
      const power = Math.min(base.E0 * 0.98, Math.max(0.02, base.P * ratio));
      const theta = deg(Math.asin(Math.max(-1, Math.min(1, power / base.E0))));
      return stateFromE0Vector({ x: base.E0 * Math.cos(rad(theta)), y: base.E0 * Math.sin(rad(theta)) });
    }
    const theta = Math.max(5, Math.min(70, base.theta + (up ? 10 : -10)));
    return stateFromE0Vector({ x: base.E0 * Math.cos(rad(theta)), y: base.E0 * Math.sin(rad(theta)) });
  }
  return null;
}

/** 默认调节点对应的倍数：滑块初值必须与题目要求的默认示意点一致，否则一拖就跳变 */
function defaultLevel(change, hold, direction, base) {
  const up = direction === 'increase';
  if (change === 'active' && hold !== 'excitation') return up ? 1.35 : 0.7;
  if (change !== 'active') return up ? 1.6 : 0.4;
  const theta = Math.max(5, Math.min(70, base.theta + (up ? 10 : -10)));
  const power = base.E0 * Math.sin(rad(theta));
  return base.P > 1e-6 ? power / base.P : 1;
}

/** 可拖动变量：题目要求「哪个量变」，滑块就控制哪个量（以额定点的倍数表示） */
function sliderFor(change, hold, direction, base) {
  const value = Math.round(defaultLevel(change, hold, direction, base) * 1000) / 1000;
  if (change === 'active') {
    return {
      key: 'active',
      label: hold === 'excitation' ? '有功功率 P（励磁电流不变）' : '有功功率 P',
      min: 0.2,
      max: 1.8,
      step: 0.01,
      value,
      unit: '× 额定',
    };
  }
  if (change === 'excitation') {
    return {
      key: 'excitation',
      label: '励磁电流 i_f（以无功 Q 体现）',
      min: 0.2,
      max: 2.2,
      step: 0.01,
      value,
      unit: '× 额定',
    };
  }
  return {
    key: 'reactive',
    label: '无功功率 Q',
    min: 0.2,
    max: 2.2,
    step: 0.01,
    value,
    unit: '× 额定',
  };
}

/** 拖动时同步显示的数值（归一化相对值，不是题目数值） */
function metricsFor(state) {
  const cosphi = state.I > 1e-9 ? state.P / state.I : 0;
  return [
    { key: 'P', label: '有功 P', value: round(state.P, 3), unit: 'p.u.' },
    { key: 'Q', label: '无功 Q', value: round(state.Q, 3), unit: 'p.u.' },
    { key: 'E0', label: 'Ė₀ 幅值', value: round(state.E0, 3), unit: 'p.u.' },
    { key: 'theta', label: '功角 θ', value: round(state.theta, 3), unit: '°' },
    { key: 'I', label: 'İ 幅值', value: round(state.I, 3), unit: 'p.u.' },
    { key: 'phi', label: '功率因数角 φ', value: round(state.phi, 3), unit: '°' },
    { key: 'cosphi', label: 'cosφ', value: round(cosphi, 3), unit: '' },
  ];
}

function scenarioLabel(change, hold, direction) {
  const dir = direction === 'increase' ? '增大' : '减小';
  if (change === 'active') {
    return hold === 'reactive'
      ? `有功功率${dir}，无功功率不变`
      : `有功功率${dir}，励磁电流不变`;
  }
  return `${CHANGE_LABELS[change] || change}${dir}，${HOLD_LABELS[hold] || hold}不变`;
}

/**
 * 兜底：模型没有按约定填 qualitative 时，从题干关键词识别常见的调节套路。
 * 只在题目明确是「变化轨迹 / 定性分析」且能确定「保持哪个量不变」时才生效。
 */
function inferQualitative(ir) {
  const text = [
    ir?.title,
    ir?.question,
    ...(Array.isArray(ir?.ask) ? ir.ask : []),
    ...(Array.isArray(ir?.notes) ? ir.notes : []),
  ].filter(Boolean).join(' ');
  if (!/轨迹|变化趋势|定性分析|如何变化/.test(text)) return null;
  if (!/有功|无功|励磁|功角|功率因数/.test(text)) return null;

  let hold = '';
  if (/保持[^。；\n]{0,8}无功[^。；\n]{0,4}不变|无功[^。；\n]{0,4}不变/.test(text)) hold = 'reactive';
  else if (/保持[^。；\n]{0,8}励磁[^。；\n]{0,4}不变|励磁[^。；\n]{0,4}不变/.test(text)) hold = 'excitation';
  else if (/保持[^。；\n]{0,8}有功[^。；\n]{0,4}不变|有功[^。；\n]{0,4}不变/.test(text)) hold = 'active';
  if (!hold) return null;

  let change = '';
  if (hold === 'reactive') change = 'active';
  else if (hold === 'excitation') change = 'active';
  else if (hold === 'active') change = /励磁/.test(text) ? 'excitation' : 'reactive';

  const direction = /减小|减少|降低/.test(text) && !/增加|增大|提高/.test(text) ? 'decrease' : 'increase';
  return {
    machine: 'cylindrical-sync-generator',
    change,
    hold,
    direction,
  };
}

function solveQualitative(ir, options = {}) {
  const raw = ir?.qualitative && typeof ir.qualitative === 'object' ? ir.qualitative : ir;
  const machineRaw = raw?.machine || ir?.machine;
  let machine = pickAlias(MACHINE_ALIASES, machineRaw);
  if (!machine) {
    // 模型漏填 machine 时，按题干/标题里的关键词兜底，避免整题直接失败
    const hint = [ir?.title, ir?.question, ...(Array.isArray(ir?.ask) ? ir.ask : [])].filter(Boolean).join(' ');
    if (/隐极|同步发电机|同步电机/.test(hint)) machine = 'cylindrical-sync-generator';
  }
  if (!machine) {
    return emptyResult([`相量图引擎目前只内置了「隐极同步发电机（并联大电网）」的定性模板；题目给出的电机类型是「${String(machineRaw || '未填写')}」，暂不能按固定套路出图。可以按「电压方程 + 相量关系」用文字讲解，或在 qualitative.machine 里改为 cylindrical-sync-generator。`]);
  }

  const change = pickAlias(CHANGE_ALIASES, raw?.change);
  const hold = pickAlias(HOLD_ALIASES, raw?.hold);
  const direction = pickAlias(DIRECTION_ALIASES, raw?.direction) || 'increase';

  if (!change) {
    return {
      ...emptyResult(['没有识别出「调节哪个量」：请在 qualitative.change 里写 active / reactive / excitation 之一']),
      needsClarification: true,
    };
  }
  if (!hold) {
    return {
      ...emptyResult(['没有识别出「保持哪个量不变」：请在 qualitative.hold 里写 active / reactive / excitation 之一']),
      needsClarification: true,
    };
  }
  const compatible = (change === 'active' && (hold === 'reactive' || hold === 'excitation'))
    || ((change === 'reactive' || change === 'excitation') && hold === 'active');
  if (!compatible) {
    return emptyResult([`不支持的组合：「改变${CHANGE_LABELS[change]}、保持${HOLD_LABELS[hold]}不变」不在内置定性模板内。常见可分析组合：有功增减且无功不变、励磁增减且有功不变、有功增减且励磁不变。`]);
  }

  const base = stateFromE0Vector({ x: BASE.E0 * Math.cos(rad(BASE.THETA0)), y: BASE.E0 * Math.sin(rad(BASE.THETA0)) });
  const sweepValue = toNumber(options?.sweep, NaN);
  const sweeping = Number.isFinite(sweepValue);
  const target = targetState(change, hold, direction, base, sweeping ? sweepValue : undefined);
  if (!target || !Number.isFinite(target.E0) || target.E0 <= 0) {
    return emptyResult(['定性模板计算失败：调节后的相量无法确定。']);
  }

  const label = scenarioLabel(change, hold, direction);
  const guides = guidesFor(change, hold, base);
  const conclusions = conclusionsFor(change, hold, direction);

  const before = { suffix: '1', subscript: '₁' };
  const after = { suffix: '2', subscript: '₂' };
  const basePhasors = phasorSet(base, before);
  const bothPhasors = [
    ...phasorSet(base, { ...before, dashed: true }),
    ...phasorSet(target, after),
  ];
  const guidesText = guides.map((guide) => {
    if (guide.type === 'vline') return `Ė₀ 端点沿 x = ${round(guide.x)} 的竖直线移动`;
    if (guide.type === 'hline') return `İ 端点沿 y = ${round(guide.y)} 的水平线移动`;
    return `端点沿半径 ${round(guide.r)} 的圆弧移动`;
  });

  const steps = [
    {
      title: '取参考相量与电压方程',
      detail: '并联大电网 → 端电压 $U$、频率 $f$ 不变。取 $\\dot{U} = U\\angle 0^\\circ$（$U$ 归一化为 1），按发电机惯例列电压方程。',
      formula: '$\\dot{E}_0 = \\dot{U} + j\\dot{I}X_s$',
      diagram: {
        kind: 'phasor',
        normalized: true,
        reference: { label: 'U̇', angle: 0 },
        phasors: phasorSet(base, { suffix: '1', subscript: '₁' }).slice(0, 1),
        guides: [],
      },
    },
    {
      title: '按额定工况画出相量',
      detail: '$\\dot{I}_1$ 滞后 $\\dot{U}$ 角 $\\varphi_1$；$j\\dot{I}_1X_s$ 由 $\\dot{U}$ 端点首尾相接画出，其端点为 $\\dot{E}_{01}$。$\\dot{E}_{01}$ 的横坐标由无功决定，纵坐标由有功决定。',
      formula: '$E_{0x} = U + \\frac{QX_s}{U}$，$E_{0y} = \\frac{PX_s}{U}$',
      diagram: {
        kind: 'phasor',
        normalized: true,
        reference: { label: 'U̇', angle: 0 },
        phasors: basePhasors,
        guides: [],
      },
    },
    {
      title: '标出端点轨迹',
      detail: `按「${label}」确定两条轨迹：${guidesText.join('；')}。轨迹由电压方程直接推出，画图时先画轨迹再取调节后的点。`,
      formula: change === 'active' && hold === 'reactive'
        ? '$Q$ 不变 $\\Rightarrow E_{0x}$ 不变；$P\\uparrow \\Rightarrow E_{0y}\\uparrow$'
        : (hold === 'active'
          ? '$P$ 不变 $\\Rightarrow E_{0y}$ 不变；$Q$ 变化 $\\Rightarrow E_{0x}$ 变化'
          : '$E_0$ 不变 $\\Rightarrow$ 端点沿圆弧移动'),
      diagram: {
        kind: 'phasor',
        normalized: true,
        reference: { label: 'U̇', angle: 0 },
        phasors: basePhasors,
        guides,
      },
    },
    {
      title: '在轨迹上取调节后的点并重画',
      detail: '沿轨迹取调节后的 $\\dot{E}_{02}$，再由 $\\dot{E}_{02} = \\dot{U} + j\\dot{I}_2X_s$ 反推 $\\dot{I}_2$；虚线为调节前，实线为调节后。$\\theta$ 为 $\\dot{E}_0$ 与 $\\dot{U}$ 的夹角。',
      formula: '$\\dot{E}_{02} = \\dot{U} + j\\dot{I}_2X_s$',
      diagram: {
        kind: 'phasor',
        normalized: true,
        reference: { label: 'U̇', angle: 0 },
        phasors: bothPhasors,
        guides,
      },
    },
    {
      title: '读图得出结论',
      detail: `${label}：${conclusions.map(([name, delta]) => `${name}${delta}`).join('，')}。`,
      formula: conclusions.map(([name, delta, reason]) => `${name}：${delta}（${reason}）`).join('\n'),
      value: conclusions.map(([name, delta]) => `${name} ${delta}`).join('；'),
    },
  ];

  const afterPhasors = phasorSet(target, after);
  return {
    ok: true,
    errors: [],
    warnings: [],
    qualitative: true,
    normalized: true,
    machine,
    change,
    hold,
    direction,
    scenario: `${change}-${direction}-${hold}`,
    scenarioLabel: label,
    notice: '定性题：图中数值为归一化示意值（U 基准 = 1），只表达相量之间的相对大小、相位和端点轨迹，不代表题目数值。',
    assumptions: [
      '隐极同步发电机、忽略定子电阻、并联无穷大电网（U、f 恒定）',
      '相量均为有效值，角度逆时针为正，U̇ 取 0° 参考',
      `示意图按额定点 E₀ = ${BASE.E0}（相对值）、θ = ${BASE.THETA0}° 等比缩放绘制`,
    ],
    steps,
    phasors: afterPhasors,
    guides,
    reference: { label: 'U̇', angle: 0 },
    verified: false,
    unverified: false,
    summary: [
      `分析对象：${MACHINE_LABELS[machine]}`,
      `调节方式：${label}`,
      `额定示意点：θ₀ = ${round(base.theta)}°，φ₀ = ${round(base.phi)}°`,
      sweeping
        ? `滑块位置：${sliderFor(change, hold, direction, base).label} = ×${round(sweepValue)} 额定（θ = ${round(target.theta)}°，φ = ${round(target.phi)}°）`
        : `调节后示意点：θ = ${round(target.theta)}°，φ = ${round(target.phi)}°`,
      `结论：${conclusions.map(([name, delta]) => `${name}${delta}`).join('；')}`,
      sweeping
        ? '注意：当前图是滑块所在位置的示意状态；结论仍按题目要求的调节方向给出，拖动滑块只改变图上相量。'
        : '注意：定性结论来自固定分析表；具体数值题请按题目给定参数另算。',
    ],
    slider: sliderFor(change, hold, direction, base),
    metrics: metricsFor(target),
    needsClarification: false,
    ambiguities: [],
  };
}

/* ------------------------------------------------------------------ 主入口 */

function solvePhasor(ir, options = {}) {
  const mode = String(ir?.mode || (ir?.qualitative ? 'qualitative' : 'given')).trim().toLowerCase();
  if (mode === 'qualitative') return solveQualitative(ir, options);

  const ambiguities = Array.isArray(ir?.ambiguities) ? ir.ambiguities.filter((item) => item?.question) : [];
  if (ambiguities.length && !options.ignoreAmbiguities) {
    return { ...emptyResult(['读图存在歧义，请先确认下面的问题，确认后再画相量图']), needsClarification: true, ambiguities };
  }

  const errors = [];
  const warnings = [];
  const list = Array.isArray(ir?.phasors) ? ir.phasors : [];
  if (!list.length) {
    // 模型没按定性模式输出、但题干明显是「轨迹 / 变化」题时，自动套用内置模板
    const inferred = inferQualitative(ir);
    if (inferred) {
      const out = solveQualitative({ ...ir, mode: 'qualitative', qualitative: inferred }, options);
      if (out.ok) out.summary = [`模型未标注定性模式，已按题干自动识别为「${out.scenarioLabel}」`, ...out.summary];
      return out;
    }
    errors.push('没有识别到任何相量');
  }

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
