import React, { useMemo } from 'react';

/**
 * 学科分析简图（纯 SVG，由 IR 直接绘制）。
 *
 * 这里只负责「把结构化中间结果画出来」，不参与任何计算：
 *   - 电路：节点 + 元件符号 + 端口；
 *   - 单线图：母线 + 线路 / 变压器 + 负荷。
 * 图上的数值来自求解结果，没有结果时只显示元件标称值。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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

function PhasorView({ ir, result, compact = false }) {
  const width = 500;
  const height = 380;
  const origin = { x: 250, y: 200 };
  const radius = 140;
  const guides = Array.isArray(ir?.guides) && ir.guides.length
    ? ir.guides
    : (Array.isArray(result?.guides) ? result.guides : []);
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

  const radiansOf = (angle) => (angle * Math.PI) / 180;
  // 每条相量都换算成「起点 + 向量终点」的直角坐标，jİX_s 这类首尾相接的相量才画得对
  const segments = phasors.map((item) => {
    const start = item.start && Number.isFinite(Number(item.start.real)) && Number.isFinite(Number(item.start.imag))
      ? { real: Number(item.start.real), imag: Number(item.start.imag) }
      : { real: 0, imag: 0 };
    const vector = { real: item.magnitude * Math.cos(radiansOf(item.angle)), imag: item.magnitude * Math.sin(radiansOf(item.angle)) };
    return {
      ...item,
      start,
      end: { real: start.real + vector.real, imag: start.imag + vector.imag },
      vector,
    };
  });

  const extents = [1];
  segments.forEach((item) => {
    extents.push(Math.hypot(item.start.real, item.start.imag), Math.hypot(item.end.real, item.end.imag));
  });
  guides.forEach((guide) => {
    if (guide.type === 'vline') extents.push(Math.abs(Number(guide.x) || 0));
    else if (guide.type === 'hline') extents.push(Math.abs(Number(guide.y) || 0));
    else if (guide.type === 'circle') {
      const cx = Number(guide.cx) || 0;
      const cy = Number(guide.cy) || 0;
      const r = Number(guide.r) || 0;
      extents.push(Math.hypot(cx, cy) + r);
    }
  });
  const maxExtent = Math.max(...extents.filter((value) => Number.isFinite(value)), 1);
  const scale = radius / maxExtent;

  const toPoint = (real, imag) => ({
    x: origin.x + real * scale,
    y: origin.y - imag * scale,
  });

  if (!segments.length) {
    return <div style={{ padding: 20, fontSize: 12, color: 'var(--muted)' }}>还没有相量数据：先识别题目或手动补一个相量。</div>;
  }

  const refPoint = toPoint(Math.cos(radiansOf(reference.angle || 0)) * maxExtent, Math.sin(radiansOf(reference.angle || 0)) * maxExtent);

  // 标签避让：先给每个箭头找候选位置，放不下就换位，并用引线指回箭头
  const labelFont = compact ? 8.4 : 9.6;
  const occupied = [];
  // 轨迹编号徽标参与避让，避免相量名称压到编号上
  const guideBadges = compact ? [] : guides.map((guide, index) => {
    if (guide.type === 'vline') return { index, x: toPoint(Number(guide.x) || 0, 0).x, y: 36 };
    if (guide.type === 'hline') return { index, x: width - 32, y: toPoint(0, Number(guide.y) || 0).y };
    if (guide.type === 'circle') {
      const cx = Number(guide.cx) || 0;
      const cy = Number(guide.cy) || 0;
      const r = (Number(guide.r) || 0) * scale;
      const center = toPoint(cx, cy);
      return { index, x: center.x + r * 0.72, y: center.y - r * 0.72 };
    }
    return null;
  }).filter(Boolean);
  guideBadges.forEach((badge) => {
    occupied.push({ left: badge.x - 9, top: badge.y - 9, right: badge.x + 9, bottom: badge.y + 9 });
  });
  // 坐标轴两端的短标记也纳入避让
  occupied.push({ left: width - 34, top: origin.y - 18, right: width - 4, bottom: origin.y - 2 });
  occupied.push({ left: origin.x + 2, top: 14, right: origin.x + 42, bottom: 30 });
  occupied.push({ left: origin.x - 16, top: origin.y + 4, right: origin.x - 2, bottom: origin.y + 17 });
  const overlaps = (a, b) => !(a.right + 2 < b.left || a.left - 2 > b.right || a.bottom + 2 < b.top || a.top - 2 > b.bottom);
  const candidates = [
    { dx: 10, dy: -4, anchor: 'start' },
    { dx: 10, dy: 14, anchor: 'start' },
    { dx: -10, dy: -4, anchor: 'end' },
    { dx: -10, dy: 14, anchor: 'end' },
    { dx: 24, dy: -20, anchor: 'start' },
    { dx: -24, dy: 22, anchor: 'end' },
    { dx: 0, dy: -14, anchor: 'middle' },
    { dx: 0, dy: 20, anchor: 'middle' },
  ];
  // AI 答疑补充的相量用紫色虚线单独区分；调节前的虚线相量仍不标名称
  const colorOf = (item) => {
    if (item.source === 'assistant') return '#7c3aed';
    return item.quantity === 'current' ? '#ea580c' : 'var(--accent, #2563eb)';
  };
  const labelLayout = segments.filter((item) => !item.dashed || item.source === 'assistant').map((item) => {
    const head = toPoint(item.end.real, item.end.imag);
    // 图内只放相量名称；幅值、角度与含义统一放到图外的「图示说明」
    const text = item.label;
    const boxWidth = Math.min(width - 44, Math.max(24, text.length * labelFont * 0.58 + 8));
    const boxHeight = labelFont + 4;
    let chosen = null;
    for (const candidate of candidates) {
      const boxLeft = candidate.anchor === 'start'
        ? head.x + candidate.dx
        : candidate.anchor === 'end'
          ? head.x + candidate.dx - boxWidth
          : head.x + candidate.dx - boxWidth / 2;
      const baseline = head.y + candidate.dy;
      if (boxLeft < 2 || boxLeft + boxWidth > width - 2 || baseline - boxHeight < 14 || baseline > height - 30) continue;
      const box = { left: boxLeft, top: baseline - boxHeight + 3, right: boxLeft + boxWidth, bottom: baseline + 3 };
      if (occupied.some((used) => overlaps(box, used))) continue;
      const textX = candidate.anchor === 'start' ? boxLeft : candidate.anchor === 'end' ? boxLeft + boxWidth : boxLeft + boxWidth / 2;
      chosen = { ...candidate, boxLeft, textX, baseline, box };
      break;
    }
    if (!chosen) {
      const candidate = candidates[candidates.length - 1];
      let boxLeft = head.x + candidate.dx - boxWidth / 2;
      boxLeft = Math.max(2, Math.min(width - 2 - boxWidth, boxLeft));
      const baseline = Math.max(20, Math.min(height - 32, head.y + candidate.dy));
      const box = { left: boxLeft, top: baseline - boxHeight + 3, right: boxLeft + boxWidth, bottom: baseline + 3 };
      chosen = { ...candidate, boxLeft, textX: boxLeft + boxWidth / 2, baseline, box };
    }
    occupied.push(chosen.box);
    const color = colorOf(item);
    const towardX = Math.max(chosen.box.left, Math.min(head.x, chosen.box.right));
    const towardY = Math.max(chosen.box.top, Math.min(head.y, chosen.box.bottom));
    const leader = Math.hypot(towardX - head.x, towardY - head.y) > 14;
    return { item, head, text, color, chosen, leader, towardX, towardY };
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} shapeRendering="geometricPrecision" style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="相量图">
      {/* 坐标轴 */}
      <line x1={30} y1={origin.y} x2={width - 20} y2={origin.y} stroke="var(--line-strong, #94a3b8)" strokeWidth="1.2" />
      <line x1={origin.x} y1={height - 30} x2={origin.x} y2={20} stroke="var(--line-strong, #94a3b8)" strokeWidth="1.2" />
      <polygon points={`${width - 20},${origin.y} ${width - 30},${origin.y - 4} ${width - 30},${origin.y + 4}`} fill="var(--line-strong, #94a3b8)" />
      <polygon points={`${origin.x},20 ${origin.x - 4},30 ${origin.x + 4},30`} fill="var(--line-strong, #94a3b8)" />
      <text x={width - 24} y={origin.y - 8} fontSize="8.5" textAnchor="end" fill="var(--muted, #64748b)">{compact ? '' : '0°'}</text>
      <text x={origin.x + 8} y={26} fontSize="8.5" fill="var(--muted, #64748b)">{compact ? '' : '+90°'}</text>
      <text x={origin.x - 8} y={origin.y + 14} fontSize="9" textAnchor="end" fill="var(--muted, #64748b)">O</text>

      {/* 参考轴（U̇ 方向），不再重复文字标签 */}
      <line
        x1={origin.x}
        y1={origin.y}
        x2={refPoint.x}
        y2={refPoint.y}
        stroke="var(--muted, #64748b)"
        strokeWidth="1"
        strokeDasharray="5 4"
      />

      {/* 端点轨迹：图内只画线 + 编号，文字说明移到图外 */}
      {guides.map((guide, index) => {
        const stroke = 'var(--accent, #2563eb)';
        if (guide.type === 'vline') {
          const x = toPoint(Number(guide.x) || 0, 0).x;
          return <line key={`guide-${index}`} x1={x} y1={26} x2={x} y2={height - 30} stroke={stroke} strokeWidth="1" strokeDasharray="6 4" opacity="0.55" />;
        }
        if (guide.type === 'hline') {
          const y = toPoint(0, Number(guide.y) || 0).y;
          return <line key={`guide-${index}`} x1={30} y1={y} x2={width - 20} y2={y} stroke={stroke} strokeWidth="1" strokeDasharray="6 4" opacity="0.55" />;
        }
        if (guide.type === 'circle') {
          const center = toPoint(Number(guide.cx) || 0, Number(guide.cy) || 0);
          const r = (Number(guide.r) || 0) * scale;
          return <circle key={`guide-${index}`} cx={center.x} cy={center.y} r={r} fill="none" stroke={stroke} strokeWidth="1" strokeDasharray="6 4" opacity="0.55" />;
        }
        return null;
      })}
      {guideBadges.map((badge) => (
        <g key={`badge-${badge.index}`}>
          <circle cx={badge.x} cy={badge.y} r="8" fill="var(--surface, #fff)" stroke="var(--accent, #2563eb)" strokeWidth="1" opacity="0.92" />
          <text x={badge.x} y={badge.y + 0.5} fontSize="9" fontWeight={700} textAnchor="middle" fill="var(--accent, #2563eb)">
            {String(badge.index + 1)}
          </text>
        </g>
      ))}

      {segments.map((item, index) => {
        const start = toPoint(item.start.real, item.start.imag);
        const head = toPoint(item.end.real, item.end.imag);
        const color = colorOf(item);
        const dx = head.x - start.x;
        const dy = head.y - start.y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const base = { x: head.x - ux * 8, y: head.y - uy * 8 };
        const normal = { x: -uy * 4, y: ux * 4 };
        const dashed = Boolean(item.dashed);
        return (
          <g key={item.id || index} opacity={dashed ? (item.source === 'assistant' ? 0.85 : 0.45) : 1}>
            <line
              x1={start.x}
              y1={start.y}
              x2={head.x}
              y2={head.y}
              stroke={color}
              strokeWidth={dashed ? 1.4 : 2}
              strokeDasharray={dashed ? '5 4' : undefined}
            />
            <polygon points={`${head.x},${head.y} ${base.x + normal.x},${base.y + normal.y} ${base.x - normal.x},${base.y - normal.y}`} fill={color} />
          </g>
        );
      })}

      {labelLayout.map(({ item, head, text, color, chosen, leader, towardX, towardY }, index) => (
        <g key={`label-${item.id || index}`} opacity={item.dashed ? (item.source === 'assistant' ? 0.9 : 0.6) : 1}>
          {leader ? (
            <line x1={head.x} y1={head.y} x2={towardX} y2={towardY} stroke={color} strokeWidth="0.8" opacity="0.45" />
          ) : null}
          <text
            x={chosen.textX}
            y={chosen.baseline}
            fontSize={labelFont}
            fontWeight={600}
            fill={color}
            textAnchor={chosen.anchor}
          >
            {text}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ------------------------------------------------ 相量图外的文字说明 */

const GUIDE_ORDINALS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const PHASOR_BASE_WIDTH = 640;
const PHASOR_BASE_HEIGHT = 487;

/** 图外说明：轨迹编号、相量幅值/角度、颜色与坐标轴含义 */
export function PhasorFigureLegend({ ir, result }) {
  const guides = (Array.isArray(ir?.guides) && ir.guides.length ? ir.guides : (result?.guides || []))
    .filter((guide) => guide?.label);
  const phasors = (result?.phasors?.length ? result.phasors : (ir?.phasors || []))
    .filter((item) => Number(item?.magnitude) > 0);
  if (!guides.length && !phasors.length) return null;
  const illustrative = Boolean(ir?.normalized || result?.normalized);
  const muted = { fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.7 };
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, border: '1px dashed var(--line)', background: 'var(--surface)', display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.04em' }}>图示说明</div>
      {guides.length ? (
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 2 }}>端点轨迹</div>
          {guides.map((guide, index) => (
            <div key={index} style={muted}>
              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{GUIDE_ORDINALS[index] || `${index + 1}.`}</span>
              {' '}
              {guide.label}{guide.source === 'assistant' ? '（AI 补充）' : ''}
            </div>
          ))}
        </div>
      ) : null}
      {phasors.length ? (
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 2 }}>
            相量{illustrative ? '（归一化示意值）' : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
            {phasors.map((item, index) => (
              <span key={item.id || index} style={{ fontSize: 10.5, color: item.source === 'assistant' ? '#7c3aed' : item.quantity === 'current' ? '#c2410c' : 'var(--accent)' }}>
                {item.label}
                {' = '}
                {item.magnitude}{item.unit || ''} ∠{item.angle}°
                {item.source === 'assistant' ? '（AI 补充，示意）' : ''}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div style={muted}>
        横轴为实轴（0°），纵轴为虚轴（+90°）；虚线为参考轴、调节前相量或 AI 补充关系，紫色为 AI 答疑补充，蓝色为电压、橙色为电流。
      </div>
    </div>
  );
}

/* ------------------------------------------------------ 可缩放相量图查看器 */

function clampZoom(value) {
  return Math.max(0.45, Math.min(5, value));
}

function PhasorCanvas({ ir, result, height = 480, onExpand, onClose }) {
  const boxRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef(null);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  const fit = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const heightPx = el.clientHeight;
    if (!width || !heightPx) return;
    const next = clampZoom(Math.min((width - 16) / PHASOR_BASE_WIDTH, (heightPx - 16) / PHASOR_BASE_HEIGHT));
    panRef.current = {
      x: (width - PHASOR_BASE_WIDTH * next) / 2,
      y: (heightPx - PHASOR_BASE_HEIGHT * next) / 2,
    };
    zoomRef.current = next;
    setZoom(next);
    setPan(panRef.current);
  }, []);

  useEffect(() => {
    fit();
  }, [fit, ir, result]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const handleWheel = (event) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      const prev = zoomRef.current;
      const next = clampZoom(prev * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
      if (next === prev) return;
      zoomRef.current = next;
      const current = panRef.current;
      const nextPan = {
        x: cx - (cx - current.x) * (next / prev),
        y: cy - (cy - current.y) * (next / prev),
      };
      panRef.current = nextPan;
      setZoom(next);
      setPan(nextPan);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  const actualSize = () => {
    const el = boxRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const heightPx = el.clientHeight;
    zoomRef.current = 1;
    const nextPan = {
      x: (width - PHASOR_BASE_WIDTH) / 2,
      y: (heightPx - PHASOR_BASE_HEIGHT) / 2,
    };
    panRef.current = nextPan;
    setZoom(1);
    setPan(nextPan);
  };

  const startDrag = (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.('button')) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, pan: panRef.current };
    event.currentTarget.style.cursor = 'grabbing';
  };
  const moveDrag = (event) => {
    if (!dragRef.current) return;
    const nextPan = {
      x: dragRef.current.pan.x + event.clientX - dragRef.current.startX,
      y: dragRef.current.pan.y + event.clientY - dragRef.current.startY,
    };
    panRef.current = nextPan;
    setPan(nextPan);
  };
  const endDrag = (event) => {
    dragRef.current = null;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* 已释放 */ }
    event.currentTarget.style.cursor = 'grab';
  };

  const toolStyle = {
    border: '1px solid var(--line)',
    background: 'var(--surface)',
    color: 'var(--text)',
    borderRadius: 7,
    padding: '3px 9px',
    fontSize: 10.5,
    cursor: 'pointer',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: typeof height === 'number' ? height : height }}>      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <button type="button" style={toolStyle} onClick={fit}>适应窗口</button>
        <button type="button" style={toolStyle} onClick={actualSize}>原始大小</button>
        <button type="button" style={toolStyle} onClick={fit}>复位</button>
        <span style={{ fontSize: 10.5, color: 'var(--muted)', minWidth: 38, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>滚轮缩放 · 拖动平移</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {onExpand ? <button type="button" style={toolStyle} onClick={onExpand}>放大查看</button> : null}
          {onClose ? <button type="button" style={toolStyle} onClick={onClose}>关闭</button> : null}
        </div>
      </div>
      <div
        ref={boxRef}
        style={{ position: 'relative', flex: 1, minHeight: 220, overflow: 'hidden', background: 'var(--surface-soft)', cursor: 'grab', touchAction: 'none' }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        <div style={{ position: 'absolute', left: 0, top: 0, width: PHASOR_BASE_WIDTH, height: PHASOR_BASE_HEIGHT, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0', willChange: 'transform' }}>
          <AnalysisDiagram ir={ir} result={result} />
        </div>
      </div>
    </div>
  );
}

/** 主图查看器：内嵌可缩放画布 + 放大浮层 */
export function PhasorDiagramViewer({ ir, result }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return undefined;
    const handleKey = (event) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [expanded]);
  return (
    <>
      <PhasorCanvas ir={ir} result={result} height={560} onExpand={() => setExpanded(true)} />
      {expanded ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="放大查看相量图"
          style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setExpanded(false)}
        >
          <div
            style={{ width: '92vw', height: '88vh', background: 'var(--surface)', borderRadius: 14, boxShadow: '0 24px 70px rgba(0,0,0,0.35)', overflow: 'hidden' }}
            onClick={(event) => event.stopPropagation()}
          >
            <PhasorCanvas ir={ir} result={result} height="calc(88vh - 2px)" onClose={() => setExpanded(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function AnalysisDiagram({ ir, result, compact = false }) {
  if (!ir) {
    return <div style={{ padding: 20, fontSize: 12, color: 'var(--muted)' }}>还没有结构化结果：先识别题干或图片。</div>;
  }
  if (ir.kind === 'phasor') return <PhasorView ir={ir} result={result} compact={compact} />;
  if (ir.kind === 'one-line') return <OneLineView ir={ir} result={result} />;
  return <CircuitView ir={ir} result={result} />;
}
