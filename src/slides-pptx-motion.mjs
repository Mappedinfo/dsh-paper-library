/** 将 PlainDeck 动态参数写入可编辑的 PresentationML 时间轴。
 * 沿用上游 Remotion 示例的 30 fps，合并采样位置与尺寸，避免镜头和入场
 * 同时修改同一属性。依据：Microsoft Open XML Working with animation；
 * MS-OI29500 §19.5.79（关键帧）。
 */
export const PPTX_MOTION_FPS = 30;
const number = value => Number(value.toFixed(8));
const invalid = message => Object.assign(new Error(message), { code: 'SLIDES_PPTX_EXPORT', status: 422 });
function milliseconds(frames, fallback) {
  const value = Math.round((frames ?? fallback) * 1000 / PPTX_MOTION_FPS);
  if (!Number.isSafeInteger(value) || value < 0 || value > 86_400_000) throw invalid('PPTX 动画延迟和时长不能超过 24 小时。');
  return value;
}
function bezier(x, x1, y1, x2, y2) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const at = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  let low = 0, high = 1;
  for (let i = 0; i < 32; i++) { const mid = (low + high) / 2; if (at(mid, x1, x2) < x) low = mid; else high = mid; }
  return at((low + high) / 2, y1, y2);
}
const condition = delay => `<p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>`;
const progress = (time, delay, duration, camera = false) => bezier((time - delay) / duration, ...(camera ? [.2, .8, .2, 1] : [.16, 1, .3, 1]));
const entranceFilter = Array.from({ length: 33 }, (_, i) => `${number(i / 32)},${number(progress(i / 32, 0, 1))}`).join(';');
const offsets = { 'fade-up': [0, 34], 'fade-down': [0, -34], 'fade-left': [34, 0], 'fade-right': [-34, 0] };

/** 输入为 PptxGenJS 生成、已统一重编号 cNvPr 的页面 XML。 */
export function addSlideMotion(xml, source, canvas, emu, themeBackground) {
  const elements = [...source.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)).filter(e => (e.opacity ?? 1) !== 0);
  if (!source.motion?.camera && !elements.some(e => e.animation && e.animation.enter !== 'none')) return xml;
  const shapes = [...xml.matchAll(/<p:(sp|pic|graphicFrame)>[\s\S]*?<\/p:\1>/g)].map(m => {
    const id = Number(/<p:cNvPr id="(\d+)"/.exec(m[0])?.[1]);
    const frame = /<(?:a|p):xfrm[^>]*>[\s\S]*?<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(m[0]);
    if (!id || !frame) throw invalid('PPTX 动画对象映射失败。');
    const [x, y, w, h] = frame.slice(1).map(Number);
    return { id, x: (x + w / 2) / emu.width, y: (y + h / 2) / emu.height, w: w / emu.width, h: h / emu.height };
  });
  if (shapes.length < elements.length) throw invalid('PPTX 动画对象映射失败。');
  shapes.forEach((shape, index) => { shape.element = elements[index]; });
  const camera = source.motion?.camera;
  let cameraDelay = 0, cameraDuration = 0;
  if (camera) {
    if (![camera.fromScale, camera.toScale].every(v => Number.isFinite(v) && v >= .001 && v <= 100)) throw invalid('PPTX 镜头缩放需在 0.001–100 之间。');
    cameraDelay = milliseconds(camera.delayFrames, 0);
    cameraDuration = milliseconds(camera.durationFrames, 180);
    const bgId = Math.max(1, ...shapes.map(s => s.id)) + 1;
    const fill = /<p:bgPr>([\s\S]*?)<\/p:bgPr>/.exec(xml)?.[1] ?? '<a:noFill/>';
    const background = `<p:sp><p:nvSpPr><p:cNvPr id="${bgId}" name="PlainDeck camera background"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu.width}" cy="${emu.height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
    xml = xml.replace(/(<p:spTree>[\s\S]*?<\/p:grpSpPr>)/, '$1' + background);
    xml = xml.replace(/<p:bgPr>[\s\S]*?<\/p:bgPr>/, `<p:bgPr><a:solidFill><a:srgbClr val="${themeBackground}"/></a:solidFill></p:bgPr>`);
    // 时间轴顺序也保持绘制层级；部分播放器按动画顺序合成动态对象，
    // 不遵循 spTree 顺序。背景必须先于内容，不能在末尾盖住内容。
    shapes.unshift({ id: bgId, x: .5, y: .5, w: 1, h: 1 });
  }
  let timeId = 4;
  const effects = [];
  const behavior = (spid, duration, attributes = [], filter) => `<p:cBhvr additive="base"><p:cTn id="${timeId++}" dur="${duration}" fill="hold"${filter ? ` tmFilter="${filter}"` : ''}/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>${attributes.length ? `<p:attrNameLst>${attributes.map(a => `<p:attrName>${a}</p:attrName>`).join('')}</p:attrNameLst>` : ''}</p:cBhvr>`;
  const parallel = (delay, children, preset, kind = 'entr') => `<p:par><p:cTn id="${timeId++}" presetID="${preset}" presetClass="${kind}" presetSubtype="0" fill="hold" grpId="0" nodeType="${effects.length ? 'withEffect' : 'afterEffect'}">${condition(delay)}<p:childTnLst>${children}</p:childTnLst></p:cTn></p:par>`;
  for (const shape of shapes) {
    const animation = shape.element?.animation;
    const enter = animation?.enter ?? 'none';
    const delay = enter === 'none' ? 0 : milliseconds(animation.delayFrames, 0);
    const duration = enter === 'none' ? 0 : milliseconds(animation.durationFrames, 18);
    if (enter !== 'none') {
      const visible = `<p:set>${behavior(shape.id, 1, ['style.visibility'])}<p:to><p:strVal val="visible"/></p:to></p:set>`;
      const fade = `<p:animEffect transition="in" filter="fade">${behavior(shape.id, duration, [], entranceFilter)}</p:animEffect>`;
      effects.push(parallel(delay, visible + fade, 10));
    }
    if (!camera && !offsets[enter] && enter !== 'scale') continue;
    const start = camera ? 0 : delay;
    const end = Math.max(camera ? cameraDelay + cameraDuration : 0, delay + duration, start + 1);
    const times = new Set([start, end]);
    const sample = (d, length) => { for (let i = 0; i <= 32; i++) { const t = d + length * i / 32; if (t >= start && t <= end) times.add(t); } };
    if (camera) sample(cameraDelay, cameraDuration);
    if (duration) sample(delay, duration);
    const keys = [...times].sort((a, b) => a - b).map(t => {
      const e = duration ? progress(t, delay, duration) : 1;
      const c = camera ? camera.fromScale * Math.exp(Math.log(camera.toScale / camera.fromScale) * progress(t, cameraDelay, cameraDuration, true)) : 1;
      const s = enter === 'scale' ? .94 * Math.exp(Math.log(1 / .94) * e) : 1;
      const [dx, dy] = offsets[enter] ?? [0, 0];
      return { tm: Math.round((t - start) / (end - start) * 100000),
        x: .5 + (shape.x - .5 + dx / canvas.width * (1 - e)) * c,
        y: .5 + (shape.y - .5 + dy / canvas.height * (1 - e)) * c,
        w: shape.w * c * s, h: shape.h * c * s };
    });
    let children = '';
    for (const axis of ['x', 'y', 'w', 'h']) {
      // 连接线的几何宽／高可以为零，但描边仍然可见；
      // 对零维度设置动画会让部分播放器把描边一并压没。
      if ((axis === 'w' || axis === 'h') && shape[axis] === 0) continue;
      // 常量轨道同样建立镜头延迟开始前的 fromScale。
      if (!camera && keys.every(k => k[axis] === keys[0][axis])) continue;
      const unique = [...new Map(keys.map(k => [k.tm, k])).values()];
      children += `<p:anim calcmode="lin" valueType="num">${behavior(shape.id, Math.round(end - start), [`ppt_${axis}`])}<p:tavLst>${unique.map(k => `<p:tav tm="${k.tm}"><p:val><p:fltVal val="${number(k[axis])}"/></p:val></p:tav>`).join('')}</p:tavLst></p:anim>`;
    }
    if (children) effects.push(parallel(start, children, 0, 'emph'));
  }
  if (!effects.length) return xml;
  const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold">${condition(0)}<p:childTnLst>${effects.join('')}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
  return xml.replace('</p:sld>', timing + '</p:sld>');
}
