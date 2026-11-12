/* The floating library: one set of books, two poses.
 *
 * Every book element exists once. Its "out" pose scatters it in the void with its own depth and
 * tumble; its "in" pose is measured from the shelf slot the build generated for that document.
 * Scrolling only interpolates between the two, so a cover that floats is the same cover that ends
 * up on the topic shelf — the point of the scene is the tidying, not a swap of pictures. */
(() => {
  const read = id => JSON.parse(document.getElementById(id).textContent);
  const books = read('books');
  const shelves = read('shelfmeta');
  const stage = document.getElementById('stage');
  const camera = document.getElementById('camera');
  const bookcase = document.getElementById('bookcase');
  const caseWrap = document.getElementById('case-wrap');
  const hero = document.getElementById('hero');
  const tip = document.createElement('div');
  const drive = document.getElementById('drive');
  const toast = document.createElement('div');
  if (!stage || !camera || !bookcase || !books.length) return;

  tip.className = 'tip';
  tip.setAttribute('role', 'status');
  stage.appendChild(tip);
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  document.body.appendChild(toast);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = () => window.matchMedia('(max-width: 860px)').matches;
  const hueOf = Object.fromEntries(shelves.map(shelf => [shelf.id, shelf.hue]));

  document.getElementById('count-books').textContent = String(books.length);
  document.getElementById('count-shelves').textContent = String(shelves.length);

  /* ---------- geometry per book ---------- */
  const size = book => {
    const long = Math.max(...book.title.split(/\s+/).map(word => word.length), 4);
    const bw = Math.round(Math.min(132, Math.max(88, 74 + long * 2.4)));
    const bh = Math.round(Math.min(186, Math.max(122, bw * 1.34)));
    const bt = Math.round(Math.max(11, Math.min(34, book.thickness * 0.52)));
    return { bw, bh, bt };
  };

  /* ---------- shelf wall: one cell per topic, one slot per document ---------- */
  const slotIndex = new Map();
  for (const shelf of shelves) {
    const cell = document.createElement('section');
    cell.className = 'cell';
    cell.id = `cell-${shelf.id}`;
    const label = document.createElement('h3');
    label.textContent = shelf.title;
    const row = document.createElement('div');
    row.className = 'row';
    const glow = document.createElement('div');
    glow.className = 'glow';
    cell.append(label, row, glow);
    shelf.books.forEach((href, i) => {
      const slot = document.createElement('span');
      slot.className = 'slot';
      slot.dataset.href = href;
      row.appendChild(slot);
      slotIndex.set(href, slot);
    });
    bookcase.appendChild(cell);
  }

  /* ---------- book elements ---------- */
  const nodes = books.map((book, i) => {
    const { bw, bh, bt } = size(book);
    const el = document.createElement('a');
    el.className = 'book';
    el.href = book.href;
    el.dataset.id = book.id;
    el.tabIndex = -1;
    el.setAttribute('aria-hidden', 'true');
    el.style.setProperty('--bw', `${bw}px`);
    el.style.setProperty('--bh', `${bh}px`);
    el.style.setProperty('--bt', `${bt}px`);
    el.style.setProperty('--hue', hueOf[book.shelf] ?? 210);
    el.style.setProperty('--tab', (i * 47 + 12) % 360);
    el.style.setProperty('--tsz', `${Math.max(9, Math.min(15, Math.round(bw / 8.6)))}px`);
    el.innerHTML = `<span class="solid">
      <span class="face back"></span><span class="face top"></span><span class="face bottom"></span>
      <span class="face spine"></span><span class="face fore"></span>
      <span class="face front"><span class="title">${escapeHtml(book.title)}</span><span class="foil"></span></span>
      <span class="ribbon"></span><span class="tab"></span><span class="tab tab-b"></span><span class="sticky"></span>
    </span>`;
    camera.appendChild(el);
    return {
      book,
      el,
      bw,
      bh,
      bt,
      phase: Math.random() * Math.PI * 2,
      speed: reduce ? 0 : 0.1 + Math.random() * 0.16,
      amp: 8 + Math.random() * 16,
      out: null,
      in: null,
      s: reduce ? 1 : 0,
      hover: 0,
      hoverTarget: 0,
    };
  });
  const nodeByHref = new Map(nodes.map(node => [node.book.href, node]));

  /** A seeded scatter keeps the first frame, the screenshots and every reload telling the same story. */
  let seed = 20261112;
  let measuring = false;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  // Perspective constants and the text boxes the sea must avoid, refreshed by every layout pass.
  let persp = 1300;
  let originY = 0;
  let farZ = -940;
  let view = { w: 1200, h: 800 };
  let forbidden = [];

  /**
   * A screen position whose projected book misses every text box. The clear band around a
   * headline is narrow, so the sample falls back to the corners of the frame before it gives up.
   */
  function pickClear(halfSize) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const px = (rnd() * 2 - 1) * (view.w * 0.5);
      const py = (rnd() * 2 - 1) * (view.h * 0.45);
      const clear = forbidden.every(box =>
        px + halfSize < box.left || px - halfSize > box.right || py + halfSize < box.top || py - halfSize > box.bottom,
      );
      if (clear) return { px, py };
    }
    return { px: (rnd() < 0.5 ? -1 : 1) * view.w * 0.48, py: (rnd() < 0.5 ? -1 : 1) * view.h * 0.43 };
  }

  /** A book with nowhere sideways to go retreats to the far sea, at a depth where it cannot reach the words. */
  function escapeToSea(node) {
    node.escaped = true;
    node.out.z = farZ;
    const k = persp / (persp - farZ);
    const half = Math.max((node.bw / 2) * k * 1.18, (node.bh / 2) * k * 1.18) + node.amp + 16;
    const { px, py } = pickClear(half);
    node.out.x = px / k;
    node.out.y = originY + (py - originY) / k;
  }

  function layout() {
    const rect = stage.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    view = { w: rect.width, h: rect.height };
    seed = 20261112;
    // Scatter happens in the picture the reader actually sees: a candidate position is projected
    // through the perspective and tested against the hero's text boxes, so the sea of books never
    // rises into a word.
    forbidden = ['.kicker', '.hero h1', '.lede', '.cta', '.hint']
      .map(sel => document.querySelector(sel))
      .filter(Boolean)
      .map(node => node.getBoundingClientRect())
      .filter(box => box.width > 0 && box.height > 0)
      .map(box => ({ left: box.left - cx, right: box.right - cx, top: box.top - cy, bottom: box.bottom - cy }));
    persp = small() ? 900 : 1300;
    originY = -0.04 * rect.height;
    farZ = small() ? -620 : -940;

    for (const node of nodes) {
      const depth = rnd();
      const z = small() ? -620 + depth * 780 : -980 + depth * 1280;
      const k = persp / (persp - z);
      const half = Math.max((node.bw / 2) * k * 1.18, (node.bh / 2) * k * 1.18) + node.amp + 22;
      const { px, py } = pickClear(half);
      node.escaped = false;
      node.out = {
        x: px / k,
        y: originY + (py - originY) / k,
        z,
        rx: (rnd() * 2 - 1) * (small() ? 10 : 18),
        ry: (rnd() * 2 - 1) * (small() ? 20 : 34),
        rz: (rnd() * 2 - 1) * (small() ? 12 : 22),
        s: 1,
        arc: 30 + rnd() * 90,
        lean: (rnd() * 2 - 1) * 26,
        delay: Math.min(0.42, Math.abs(px) / view.w + (Math.abs(py) / view.h) * 0.6 + depth * 0.2),
      };
    }

    packRows();
    for (const node of nodes) {
      const slot = slotIndex.get(node.book.href);
      if (!slot) continue;
      const box = slot.getBoundingClientRect();
      const scale = (box.height - 2) / node.bh;
      node.in = {
        x: box.left + box.width / 2 - cx,
        y: box.bottom - cy - (node.bh * scale) / 2 - 1,
        z: 6,
        rx: 0,
        ry: small() ? -4 : -11,
        rz: 0,
        s: scale,
      };
    }
    // rows need their gaps re-applied after widths change
    for (const cell of bookcase.querySelectorAll('.cell .row')) cell.style.gap = `${small() ? 2 : 4}px`;
    packRows();
    resolveOcclusion();
  }

  /**
   * A book's width follows from the height it is shelved at, so a line is fitted by measuring the
   * spines against the compartment and, when they will not fit, standing a second course behind.
   */
  function packRows() {
    const gap = small() ? 2 : 4;
    const board = small() ? 7 : 9;
    const baseH = small() ? 58 : 88;
    const perLine = small() ? 4 : 24;
    for (const cell of bookcase.querySelectorAll('.cell')) {
      const slots = [...cell.querySelectorAll('.slot')];
      if (!slots.length) continue;
      const template = cell.querySelector('.row');
      const inner = template.getBoundingClientRect().width - 4;
      const lines = Math.max(1, Math.ceil(slots.length / perLine));
      const per = Math.ceil(slots.length / lines);
      const rows = [];
      for (let line = 0; line < lines; line += 1) {
        let row = cell.querySelectorAll('.row')[line];
        if (!row) {
          row = document.createElement('div');
          row.className = 'row';
          cell.insertBefore(row, cell.querySelector('.glow'));
        }
        rows.push(row);
        const onLine = slots.slice(line * per, (line + 1) * per);
        row.replaceChildren(...onLine);
        const span = onLine.reduce((sum, slot) => {
          const node = nodeByHref.get(slot.dataset.href);
          return sum + (node ? (node.bw + node.bt * 0.2) / node.bh : 0.7);
        }, 0);
        const height = Math.max(24, Math.min(baseH, (inner - gap * (onLine.length - 1)) / Math.max(0.5, span)));
        row.style.minHeight = `${height + board}px`;
        for (const slot of onLine) {
          const node = nodeByHref.get(slot.dataset.href);
          slot.style.height = `${height}px`;
          slot.style.width = node ? `${node.bw * ((height - 2) / node.bh)}px` : '';
        }
      }
      for (const row of cell.querySelectorAll('.row')) {
        if (!rows.includes(row)) row.style.display = 'none';
      }
    }
  }

  /**
   * Keep the centre readable. Rather than guessing where a projected book lands, measure the
   * books in the state they actually render in and push the ones that cover the title text.
   */
  function resolveOcclusion() {
    const words = ['.kicker', '.hero h1', '.lede', '.cta a', '.cta button', '.hint']
      .map(sel => document.querySelector(sel))
      .filter(Boolean)
      .map(node => node.getBoundingClientRect());
    if (!words.length) return;
    const rect = stage.getBoundingClientRect();
    const limit = { left: rect.width * 0.6, top: rect.height * 0.6 };
    const wasSettled = nodes.map(node => [node.s, node.hover, node.hoverTarget]);
    measuring = true;
    for (let pass = 0; pass < 6; pass += 1) {
      let moved = 0;
      for (const node of nodes) {
        node.s = 0;
        node.hover = 0;
        node.hoverTarget = 0;
        pose(node, 0);
        const b = node.el.getBoundingClientRect();
        for (const word of words) {
          const ox = Math.min(b.right, word.right) - Math.max(b.left, word.left);
          const oy = Math.min(b.bottom, word.bottom) - Math.max(b.top, word.top);
          if (ox > 2 && oy > 2) {
            const bx = b.left + b.width / 2 - rect.left;
            const by = b.top + b.height / 2 - rect.top;
            const pad = node.amp + 22;
            if (ox < oy) node.out.x += bx < word.left + word.width / 2 ? -ox - pad : ox + pad;
            else node.out.y += by < word.top + word.height / 2 ? -oy - pad : oy + pad;
            // never shove a book out of the frame: if it has nowhere to go, send it to the far sea
            if (!node.escaped && (Math.abs(node.out.x) > limit.left || Math.abs(node.out.y) > limit.top)) {
              escapeToSea(node);
            }
            moved += 1;
          }
        }
      }
      if (!moved) break;
    }
    nodes.forEach((node, i) => {
      const [s, hover, hoverTarget] = wasSettled[i];
      node.s = s;
      node.hover = hover;
      node.hoverTarget = hoverTarget;
      // the measuring pass left every book drawn at its floating pose; put it back where it belongs
      pose(node, performance.now() / 1000);
    });
    measuring = false;
  }

  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp01 = t => Math.max(0, Math.min(1, t));

  function progress() {
    const span = drive.offsetHeight - window.innerHeight;
    if (span <= 0) return 1;
    return clamp01(-window.scrollY / -Math.max(1, span));
  }

  function pose(node, time) {
    const a = node.out;
    const b = node.in;
    if (!a || !b) return;
    const t = node.s;
    const e = ease(t);
    const hover = node.hover;
    let x = a.x + (b.x - a.x) * e;
    let y = a.y + (b.y - a.y) * e;
    let z = a.z + (b.z - a.z) * e;
    const rx = a.rx + (b.rx - a.rx) * e;
    let ry = a.ry + (b.ry - a.ry) * e;
    let rz = a.rz + (b.rz - a.rz) * e;
    const sc = a.s + (b.s - a.s) * e;

    // the arc is what makes the move read as a path rather than a jump
    const arc = Math.sin(e * Math.PI) * a.arc;
    y -= arc;
    x += Math.sin(e * Math.PI) * a.lean;
    // the tumble keeps easing out as the book settles upright
    rz += Math.sin((1 - e) * Math.PI * 2) * a.rz * 0.4;

    if (!reduce && !measuring) {
      const free = 1 - e;
      const bob = Math.sin(time * node.speed + node.phase);
      const sway = Math.cos(time * node.speed * 0.7 + node.phase);
      y += bob * node.amp * free;
      x += sway * node.amp * 0.6 * free;
      rz += sway * 2.2 * free;
      if (hover) {
        y -= 10 * hover;
        z += 150 * hover;
        ry += 9 * hover;
        rz -= 2 * hover;
      }
    } else if (hover) {
      z += 120 * hover;
    }

    node.el.style.transform =
      `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
    node.el.style.zIndex = String(Math.round(2000 - z));
    node.screen = { x, y, z };
  }

  /* ---------- one loop, stopped when the scene is at rest ---------- */
  let target = reduce ? 1 : 0;
  let p = 0;
  let raf = null;
  let idle = 0;

  function frame(now) {
    const time = now / 1000;
    let moving = false;
    for (const node of nodes) {
      const staggered = clamp01((target - node.out?.delay ?? 0) / (1 - 0.42));
      const want = reduce ? 1 : staggered;
      // ease each book toward its scroll target so a fast flick still looks continuous
      const delta = want - node.s;
      if (Math.abs(delta) > 0.0015) {
        node.s += delta * (reduce ? 1 : 0.16);
        moving = true;
      } else node.s = want;
      const hd = node.hoverTarget - node.hover;
      if (Math.abs(hd) > 0.002) {
        node.hover += hd * 0.2;
        moving = true;
      } else node.hover = node.hoverTarget;
      pose(node, time);
    }
    hero.style.opacity = String(1 - clamp01(target * 2.4));
    caseWrap.style.opacity = String(ease(clamp01((target - 0.12) / 0.72)));
    stage.classList.toggle('is-settled', target > 0.995);
    if (moving || !reduce) raf = requestAnimationFrame(frame);
    else idle += 1;
    if (!moving && idle > 4) raf = null;
    if (moving) idle = 0;
    if (raf === null && !reduce) {
      // keep the void alive: only restart the loop when something is on screen
      if (window.scrollY < drive.offsetHeight) raf = requestAnimationFrame(frame);
    }
  }

  function onScroll() {
    target = reduce ? 1 : progress();
    if (raf === null) raf = requestAnimationFrame(frame);
  }

  /* ---------- hover, preview and the opened book ---------- */
  const reader = document.getElementById('reader');
  const byId = new Map(nodes.map(node => [node.book.id, node]));
  let lastFocus = null;

  function showTip(node) {
    const box = node.el.getBoundingClientRect();
    const { book } = node;
    tip.innerHTML = `<b>${escapeHtml(book.title)}</b><span class="tip-shelf">${escapeHtml(book.shelfTitle)} · ${book.words.toLocaleString()} 字 · ${book.sections} 个小节</span><p>${escapeHtml(book.preview)}</p><span class="tip-cta">${book.headings.slice(0, 2).map(h => escapeHtml(h.text)).join(' · ') || '点开翻阅'}</span>`;
    const above = box.top > 210;
    tip.style.left = `${Math.max(172, Math.min(stage.clientWidth - 172, box.left + box.width / 2))}px`;
    tip.style.top = above ? `${box.top - 12}px` : `${box.bottom + 12}px`;
    tip.classList.toggle('is-below', !above);
    tip.classList.add('is-on');
  }
  const hideTip = () => tip.classList.remove('is-on');

  function say(message) {
    toast.textContent = message;
    toast.classList.add('is-on');
    clearTimeout(say.timer);
    say.timer = setTimeout(() => toast.classList.remove('is-on'), 1800);
  }

  function openReader(book, sourceEl) {
    const text = escapeHtml(book.read || book.preview);
    const mark = book.highlight && text.includes(escapeHtml(book.highlight)) ? escapeHtml(book.highlight) : null;
    const html = mark
      ? text.replace(mark, `<mark class="hl">${mark}</mark>`)
      : text;
    // a drop cap enlarges the first glyph, which would split the highlighted sentence when an excerpt opens on a date or a number
    const leadClass = /^[\u3400-\u9fff]/.test(book.read || book.preview) ? ' class="lead"' : '';
    document.getElementById('reader-meta').textContent = `${book.shelfTitle} · ${book.words.toLocaleString()} 字 · 约 ${book.mins} 分钟`;
    document.getElementById('reader-title').textContent = book.title;
    document.getElementById('reader-text').innerHTML = `<p${leadClass}>${html}</p><p>上页正文摘自 <code>${escapeHtml(book.sourcePath)}</code> 的第一段；划线与高亮只是本站把这一句挑出来的方式。</p>`;
    document.getElementById('reader-note').textContent = `本篇共 ${book.sections} 个小节；读到这里可以停下想想：这条记录回答的是哪个问题。`;
    document.getElementById('reader-sticky').textContent = `便签：整句摘录自 ${book.sourcePath}，未做改写。翻完整篇请走下面的小节链接。`;
    const index = document.getElementById('reader-index');
    index.innerHTML = book.headings.length
      ? `<p class="idx-title">夹在这一页的小节标签</p>${book.headings.map(h => `<a href="${encodeHref(h.href)}">${escapeHtml(h.text)}</a>`).join('')}`
      : `<p class="idx-title">本篇没有分节标题</p><a href="${encodeHref(book.href)}">从文首读起</a>`;
    document.getElementById('reader-open').href = encodeHref(book.href);
    document.getElementById('reader-source').href = book.sourceUrl;
    lastFocus = sourceEl || null;
    reader.hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('reader-close').focus();
  }

  function closeReader() {
    reader.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  const encodeHref = href => href.split('/').map(part => part.replace(/ /g, '%20')).join('/');

  for (const node of nodes) {
    node.el.addEventListener('pointerenter', () => {
      if (small()) return;
      node.hoverTarget = 1;
      showTip(node);
      if (raf === null) raf = requestAnimationFrame(frame);
    });
    node.el.addEventListener('pointerleave', () => {
      node.hoverTarget = 0;
      hideTip();
      if (raf === null) raf = requestAnimationFrame(frame);
    });
    node.el.addEventListener('click', event => {
      event.preventDefault();
      hideTip();
      openReader(node.book, node.el);
    });
  }

  // the keyboard path to the same reading panel, from the catalog below
  document.querySelectorAll('.card .peek').forEach(button => {
    button.addEventListener('click', () => {
      const book = books.find(item => item.id === button.dataset.book);
      if (book) openReader(book, button);
    });
  });

  document.getElementById('reader-close').addEventListener('click', closeReader);
  reader.addEventListener('click', event => {
    if (event.target === reader) closeReader();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !reader.hidden) closeReader();
  });

  document.getElementById('direct').addEventListener('click', () => {
    const top = drive.offsetTop + drive.offsetHeight - window.innerHeight;
    window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
    say('已进入书架：悬停抽书，点开翻阅');
  });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    layout();
    onScroll();
  });

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  layout();
  onScroll();
  // fonts and the wall settle a frame later, so re-measure once more
  requestAnimationFrame(() => {
    layout();
    onScroll();
  });
})();
