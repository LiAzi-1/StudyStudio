import React, { useMemo } from 'react';

/**
 * 学科分析简图（纯 SVG，由 IR 直接绘制）。
 *
 * 这里只负责「把结构化中间结果画出来」，不参与任何计算：
 *   - 电路：节点 + 元件符号 + 端口；
 *   - 单线图：母线 + 线路 / 变压器 + 负荷。
 * 图上的数值来自求解结果，没有结果时只显示元件标称值。
 */

const WIDTH = 520;
const HEIGHT = 340;

function nodePositions(nodes) {
  const map = new Map();
  const list = nodes.filter((node, index) => nodes.findIndex((item) => item.id === node.id) === index);
  if (list.length <= 8) {
    const radius = list.length <= 2 ? 0 : Math.min(140, 60 + list.length * 11);
    list.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, list.length) - Math.PI / 2;
      map.set(node.id, {
        x: Math.round(WIDTH / 2 + radius * Math.cos(angle)),
        y: Math.round(HEIGHT / 2 + radius * Math.sin(angle)),
      });
    });
  } else {
    const columns = Math.ceil(Math.sqrt(list.length));
    list.forEach((node, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      map.set(node.id, {
        x: Math.round(60 + col * (400 / Math.max(1, columns - 1))),
        y: Math.round(55 + row * 66),
      });
    });
  }
  return map;
}

function buildPositions(nodes, syntheticNodes = []) {
  const map = nodePositions(nodes);
  (syntheticNodes || []).forEach((item) => {
    const anchors = (item.anchors || []).map((id) => map.get(id)).filter(Boolean);
    if (!anchors.length) return;
    map.set(item.id, {
      x: Math.round(anchors.reduce((sum, point) => sum + point.x, 0) / anchors.length),
      y: Math.round(anchors.reduce((sum, point) => sum + point.y, 0) / anchors.length),
    });
  });
  return map;
}

function edgeGeometry(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    dx,
    dy,
    length,
    ux: dx / length,
    uy: dy / length,
    mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

function valueText(element) {
  if (element.value === undefined || element.value === null || element.value === '') return '';
  return `${element.value}${element.unit || ''}`;
}

function ElementSymbol({ element, from, to, highlighted }) {
  const geo = edgeGeometry(from, to);
  const { mid, angle } = geo;
  const label = element.label || element.id;
  const text = valueText(element);
  const stroke = highlighted ? 'var(--accent, #2563eb)' : 'var(--text, #0f172a)';

  return (
    <g>
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke={highlighted ? 'var(--accent, #2563eb)' : 'var(--line-strong, #94a3b8)'}
        strokeWidth={highlighted ? 2.6 : 1.6}
      />
      <g transform={`translate(${mid.x} ${mid.y}) rotate(${angle > 90 || angle < -90 ? angle + 180 : angle})`}>
        {element.type === 'resistor' && (
          <rect x="-16" y="-7" width="32" height="14" fill="var(--surface, #fff)" stroke={stroke} strokeWidth={highlighted ? 2.2 : 1.4} rx="2" />
        )}
        {(element.type === 'voltage_source' || element.type === 'current_source') && (
          <>
            <circle r="12" fill="var(--surface, #fff)" stroke={stroke} strokeWidth={highlighted ? 2.2 : 1.4} />
            {element.type === 'voltage_source' ? (
              <text x="0" y="4" textAnchor="middle" fontSize="12" fill={stroke}>±</text>
            ) : (
              <path d="M -5 0 L 5 0 M 2 -3 L 5 0 L 2 3" stroke={stroke} strokeWidth="1.2" fill="none" />
            )}
          </>
        )}
        {element.type === 'capacitor' && (
          <>
            <line x1="-4" y1="-9" x2="-4" y2="9" stroke={stroke} strokeWidth="2" />
            <line x1="4" y1="-9" x2="4" y2="9" stroke={stroke} strokeWidth="2" />
          </>
        )}
        {element.type === 'inductor' && (
          <path d="M -14 0 q 4 -8 8 0 q 4 -8 8 0 q 4 -8 8 0" fill="none" stroke={stroke} strokeWidth="1.4" />
        )}
        {element.type === 'switch' && (
          <>
            <circle cx="-10" cy="0" r="2.2" fill={stroke} />
            <circle cx="10" cy="0" r="2.2" fill={stroke} />
            <line x1="-10" y1="0" x2="8" y2={element.state === 'open' ? -10 : 0} stroke={stroke} strokeWidth="1.4" />
          </>
        )}
        {element.type === 'ammeter' && <text x="0" y="4" textAnchor="middle" fontSize="12" fill={stroke}>A</text>}
        <text x="0" y="-14" textAnchor="middle" fontSize="10.5" fill={highlighted ? 'var(--accent, #2563eb)' : 'var(--text, #334155)'}>{label}</text>
        {text ? <text x="0" y="24" textAnchor="middle" fontSize="10" fill="var(--muted, #64748b)">{text}</text> : null}
      </g>
    </g>
  );
}

function CircuitView({ ir, result }) {
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  const elements = Array.isArray(ir?.elements) ? ir.elements : [];
  const positions = useMemo(() => buildPositions(nodes, ir?.syntheticNodes), [nodes, ir?.syntheticNodes]);
  const highlight = useMemo(() => new Set(ir?.highlight || []), [ir?.highlight]);
  const usedNodes = useMemo(() => new Set(elements.flatMap((element) => [element?.from, element?.to])), [elements]);
  const voltageByNode = useMemo(() => {
    const map = new Map();
    (result?.nodeVoltages || []).forEach((item) => map.set(item.node, item.voltage));
    return map;
  }, [result]);
  const port = ir?.port || null;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="电路简图">
      {elements.map((element, index) => {
        const from = positions.get(String(element?.from || ''));
        const to = positions.get(String(element?.to || ''));
        if (!from || !to) {
          return (
            <text key={`bad-${index}`} x={12} y={20 + index * 14} fontSize="10" fill="var(--danger, #dc2626)">
              元件 {element?.id || index + 1} 连接不完整，未画出
            </text>
          );
        }
        return <ElementSymbol key={element.id || index} element={element} from={from} to={to} highlighted={highlight.has(element.id)} />;
      })}
      {nodes.map((node) => {
        if (!usedNodes.has(node.id)) return null;
        const point = positions.get(node.id);
        if (!point) return null;
        const voltage = voltageByNode.get(node.id);
        const isPlus = port && port.plus === node.id;
        const isMinus = port && port.minus === node.id;
        return (
          <g key={node.id}>
            <circle cx={point.x} cy={point.y} r={4.5} fill={isPlus || isMinus ? 'var(--accent, #2563eb)' : 'var(--text, #0f172a)'} />
            <text x={point.x} y={point.y - 9} textAnchor="middle" fontSize="11" fontWeight={isPlus || isMinus ? 700 : 500} fill="var(--text, #0f172a)">
              {node.label || node.id}
              {isPlus ? ' +' : isMinus ? ' −' : ''}
            </text>
            {Number.isFinite(voltage) ? (
              <text x={point.x} y={point.y + 17} textAnchor="middle" fontSize="9.5" fill="var(--muted, #64748b)">
                {voltage} V
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function OneLineView({ ir, result }) {
  const buses = Array.isArray(ir?.buses) ? ir.buses : [];
  const branches = Array.isArray(ir?.branches) ? ir.branches : [];
  const loads = Array.isArray(ir?.loads) ? ir.loads : [];

  const layout = useMemo(() => {
    const adjacency = new Map(buses.map((bus) => [bus.id, []]));
    branches.forEach((branch) => {
      if (adjacency.has(branch.from) && adjacency.has(branch.to)) {
        adjacency.get(branch.from).push(branch.to);
        adjacency.get(branch.to).push(branch.from);
      }
    });
    const root = buses.find((bus) => (ir?.sources || []).some((source) => String(source?.bus) === bus.id))?.id || buses[0]?.id;
    const depth = new Map();
    if (root) {
      depth.set(root, 0);
      const queue = [root];
      while (queue.length) {
        const node = queue.shift();
        (adjacency.get(node) || []).forEach((next) => {
          if (!depth.has(next)) {
            depth.set(next, (depth.get(node) || 0) + 1);
            queue.push(next);
          }
        });
      }
    }
    const byDepth = new Map();
    buses.forEach((bus) => {
      const level = depth.get(bus.id) ?? 0;
      if (!byDepth.has(level)) byDepth.set(level, []);
      byDepth.get(level).push(bus.id);
    });
    const tallest = Math.max(1, ...[...byDepth.values()].map((list) => list.length));
    const width = Math.max(WIDTH, 140 + Math.max(0, ...[...byDepth.keys()]) * 220);
    const height = Math.max(HEIGHT, 100 + tallest * 80);
    const positions = new Map();
    [...byDepth.entries()].forEach(([level, ids]) => {
      ids.forEach((id, index) => {
        positions.set(id, {
          x: 110 + level * 220,
          y: 80 + index * 80 + (tallest - ids.length) * 40,
        });
      });
    });
    return { width, height, positions };
  }, [buses, branches, ir]);

  const voltageByBus = useMemo(() => {
    const map = new Map();
    (result?.buses || []).forEach((item) => map.set(item.id, item.voltage));
    return map;
  }, [result]);
  const currentByBranch = useMemo(() => {
    const map = new Map();
    (result?.branches || []).forEach((item) => map.set(item.id, item.current));
    return map;
  }, [result]);

  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="单线图">
      {branches.map((branch, index) => {
        const from = layout.positions.get(branch.from);
        const to = layout.positions.get(branch.to);
        if (!from || !to) return null;
        const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
        const current = currentByBranch.get(branch.id);
        return (
          <g key={branch.id || index}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="var(--line-strong, #94a3b8)" strokeWidth="2" />
            {branch.type === 'transformer' ? (
              <>
                <circle cx={mid.x - 7} cy={mid.y} r="7" fill="none" stroke="var(--text, #0f172a)" strokeWidth="1.6" />
                <circle cx={mid.x + 7} cy={mid.y} r="7" fill="none" stroke="var(--text, #0f172a)" strokeWidth="1.6" />
              </>
            ) : null}
            <text x={mid.x} y={mid.y - 10} textAnchor="middle" fontSize="10" fill="var(--muted, #64748b)">
              {branch.label || branch.id}
              {branch.type === 'transformer' && branch.ratio ? ` ${branch.ratio}` : ''}
              {Number.isFinite(current) ? ` · ${current}A` : ''}
            </text>
          </g>
        );
      })}
      {buses.map((bus) => {
        const point = layout.positions.get(bus.id);
        if (!point) return null;
        const voltage = voltageByBus.get(bus.id);
        return (
          <g key={bus.id}>
            <line x1={point.x - 46} y1={point.y} x2={point.x + 46} y2={point.y} stroke="var(--text, #0f172a)" strokeWidth="5" strokeLinecap="round" />
            <text x={point.x} y={point.y - 10} textAnchor="middle" fontSize="10.5" fontWeight={600} fill="var(--text, #0f172a)">{bus.label || bus.id}</text>
            <text x={point.x} y={point.y + 18} textAnchor="middle" fontSize="9.5" fill="var(--muted, #64748b)">
              {Number.isFinite(voltage) ? `${voltage} kV` : (bus.voltage ? `${bus.voltage}${bus.unit || 'kV'}` : '')}
            </text>
          </g>
        );
      })}
      {loads.map((load, index) => {
        const point = layout.positions.get(load.bus);
        if (!point) return null;
        return (
          <g key={load.id || index} transform={`translate(${point.x + 30} ${point.y + 30})`}>
            <line x1="0" y1="0" x2="0" y2="18" stroke="var(--text, #0f172a)" strokeWidth="1.4" />
            <path d="M -5 18 L 5 18 L 0 27 Z" fill="var(--text, #0f172a)" />
            <text x="8" y="24" fontSize="9.5" fill="var(--muted, #64748b)">
              {load.label || load.id} {load.p}{load.unit || 'kW'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PhasorView({ ir, result }) {
  const width = 500;
  const height = 380;
  const origin = { x: 250, y: 200 };
  const radius = 140;
  const phasors = (result?.phasors?.length ? result.phasors : (Array.isArray(ir?.phasors) ? ir.phasors : []))
    .map((item) => {
      const magnitude = Number(item.magnitude);
      const angle = Number(item.angle);
      return {
        ...item,
        magnitude: Number.isFinite(magnitude) ? magnitude : 0,
        angle: Number.isFinite(angle) ? angle : 0,
      };
    })
    .filter((item) => item.magnitude > 0);
  const reference = result?.reference || ir?.reference || { label: '参考相量', angle: 0 };
  const maxMagnitude = Math.max(1, ...phasors.map((item) => item.magnitude));
  const scale = radius / maxMagnitude;

  const toPoint = (magnitude, angle) => {
    const radians = (angle * Math.PI) / 180;
    return {
      x: origin.x + magnitude * scale * Math.cos(radians),
      y: origin.y - magnitude * scale * Math.sin(radians),
    };
  };

  if (!phasors.length) {
    return <div style={{ padding: 20, fontSize: 12, color: 'var(--muted)' }}>还没有相量数据：先识别题目或手动补一个相量。</div>;
  }

  const refPoint = toPoint(maxMagnitude, reference.angle || 0);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="相量图">
      {/* 坐标轴 */}
      <line x1={30} y1={origin.y} x2={width - 20} y2={origin.y} stroke="var(--line-strong, #94a3b8)" strokeWidth="1.2" />
      <line x1={origin.x} y1={height - 30} x2={origin.x} y2={20} stroke="var(--line-strong, #94a3b8)" strokeWidth="1.2" />
      <polygon points={`${width - 20},${origin.y} ${width - 30},${origin.y - 4} ${width - 30},${origin.y + 4}`} fill="var(--line-strong, #94a3b8)" />
      <polygon points={`${origin.x},20 ${origin.x - 4},30 ${origin.x + 4},30`} fill="var(--line-strong, #94a3b8)" />
      <text x={width - 24} y={origin.y - 8} fontSize="9.5" textAnchor="end" fill="var(--muted, #64748b)">实轴 0°</text>
      <text x={origin.x + 8} y={26} fontSize="9.5" fill="var(--muted, #64748b)">虚轴 +90°</text>
      <text x={origin.x - 8} y={origin.y + 14} fontSize="9" textAnchor="end" fill="var(--muted, #64748b)">O</text>

      {/* 参考轴 */}
      <line
        x1={origin.x}
        y1={origin.y}
        x2={refPoint.x}
        y2={refPoint.y}
        stroke="var(--muted, #64748b)"
        strokeWidth="1"
        strokeDasharray="5 4"
      />
      <text x={refPoint.x + 4} y={refPoint.y - 4} fontSize="9.5" fill="var(--muted, #64748b)">{reference.label || '参考'}</text>

      {phasors.map((item, index) => {
        const point = toPoint(item.magnitude, item.angle);
        const color = item.quantity === 'current' ? '#ea580c' : 'var(--accent, #2563eb)';
        const dx = point.x - origin.x;
        const dy = point.y - origin.y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const head = {
          x: point.x,
          y: point.y,
        };
        const base = { x: point.x - ux * 8, y: point.y - uy * 8 };
        const normal = { x: -uy * 4, y: ux * 4 };
        const labelX = point.x + ux * 10;
        const labelY = point.y + uy * 10;
        return (
          <g key={item.id || index}>
            <line x1={origin.x} y1={origin.y} x2={head.x} y2={head.y} stroke={color} strokeWidth="2" />
            <polygon points={`${head.x},${head.y} ${base.x + normal.x},${base.y + normal.y} ${base.x - normal.x},${base.y - normal.y}`} fill={color} />
            <text
              x={labelX}
              y={labelY}
              fontSize="10.5"
              fontWeight={600}
              fill={color}
              textAnchor={ux >= 0 ? 'start' : 'end'}
            >
              {item.label} {item.magnitude}{item.unit || ''} ∠{item.angle}°
            </text>
            {Math.abs(item.angle) > 0.01 ? (
              <text x={origin.x + 30 * Math.cos(((item.angle / 2) * Math.PI) / 180)} y={origin.y - 30 * Math.sin(((item.angle / 2) * Math.PI) / 180)} fontSize="9" fill={color} textAnchor="middle">
                {item.angle}°
              </text>
            ) : null}
          </g>
        );
      })}
      <g transform={`translate(30 ${height - 20})`}>
        <line x1="0" y1="-4" x2="14" y2="-4" stroke="var(--accent, #2563eb)" strokeWidth="2" />
        <text x="18" y="0" fontSize="9.5" fill="var(--muted, #64748b)">电压</text>
        <line x1="60" y1="-4" x2="74" y2="-4" stroke="#ea580c" strokeWidth="2" />
        <text x="78" y="0" fontSize="9.5" fill="var(--muted, #64748b)">电流</text>
      </g>
    </svg>
  );
}

export default function AnalysisDiagram({ ir, result }) {
  if (!ir) {
    return <div style={{ padding: 20, fontSize: 12, color: 'var(--muted)' }}>还没有结构化结果：先识别题干或图片。</div>;
  }
  if (ir.kind === 'phasor') return <PhasorView ir={ir} result={result} />;
  if (ir.kind === 'one-line') return <OneLineView ir={ir} result={result} />;
  return <CircuitView ir={ir} result={result} />;
}
