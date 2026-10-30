export const nodeKinds = [
  ["data", "数据"],
  ["method", "方法"],
  ["model", "模型"],
  ["representation", "表示"],
  ["output", "结果"],
  ["decision", "条件"],
];
const kinds = new Set(nodeKinds.map(([kind]) => kind));
export function dataSkew(n, w = n.width, h = n.height) {
  return !n.compound && nodeKind(n.node || n) === "data" && (n.node || n).shape !== "database"
    ? Math.min(w * 0.3, h * 0.42, 54)
    : 0;
}
// The renderer and both routers use the same actual outline, including the
// sloping sides of data cards. A larger slant must not detach their arrows.
export function faceRange(n, side, inset = 18) {
  const vertical = side === "top" || side === "bottom",
    k = dataSkew(n),
    center = vertical ? n.x : n.y,
    size = vertical ? n.width : n.height;
  return [
    center - size / 2 + inset + (side === "top" ? k : 0),
    center + size / 2 - inset - (side === "bottom" ? k : 0),
  ];
}
export function boundaryPoint(n, side, along) {
  const vertical = side === "top" || side === "bottom",
    [lo, hi] = faceRange(n, side),
    value = Math.max(lo, Math.min(hi, along)),
    k = dataSkew(n);
  if (vertical) return { x: value, y: n.y + ((side === "top" ? -1 : 1) * n.height) / 2 };
  const t = (value - (n.y - n.height / 2)) / n.height;
  return {
    x: n.x + (side === "left" ? -n.width / 2 + k * (1 - t) : n.width / 2 - k * t),
    y: value,
  };
}
export function nodeKind(n) {
  if (kinds.has(n.visual_kind)) return n.visual_kind;
  if (n.shape === "model" || n.type === "model") return "model";
  const parts = n.presentation_members || n.members;
  if (parts?.length) {
    const kinds = new Set(parts.map(nodeKind));
    if (kinds.size === 1) return kinds.values().next().value;
  }
  return n.type || "method";
}

export function nodeShape(n, x, y, w, h) {
  const t = nodeKind(n);
  if (n.shape === "database")
    return `<path d="M${x} ${y + 11} C${x} ${y - 4} ${x + w} ${y - 4} ${x + w} ${y + 11} V${y + h - 11} C${x + w} ${y + h + 4} ${x} ${y + h + 4} ${x} ${y + h - 11}Z M${x} ${y + 11} C${x} ${y + 26} ${x + w} ${y + 26} ${x + w} ${y + 11}"/>`;
  if (t === "data") {
    const k = dataSkew(n, w, h);
    return `<polygon points="${x + k},${y} ${x + w},${y} ${x + w - k},${y + h} ${x},${y + h}"/>`;
  }
  if (t === "decision")
    return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"/>`;
  if (t === "output")
    return `<polygon points="${x + 12},${y} ${x + w - 12},${y} ${x + w},${y + h / 2} ${x + w - 12},${y + h} ${x + 12},${y + h} ${x},${y + h / 2}"/>`;
  if (t === "model")
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/><path class="model-bars" d="M${x + 8} ${y} V${y + h} M${x + w - 8} ${y} V${y + h}" fill="none"/>`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${t === "representation" ? 20 : 3}"/>`;
}
