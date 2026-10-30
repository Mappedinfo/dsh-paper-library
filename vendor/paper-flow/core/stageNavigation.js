// Navigation animates viewports only; graph coordinates and exported SVG stay unchanged.
export function createStageNavigator() {
  let frame = null,
    timer = null,
    active = false,
    marked = [];
  const clearMarks = () => {
    marked.forEach((element) => element.classList.remove("stage-target"));
    marked = [];
  };
  function cancel() {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = timer = null;
    active = false;
    clearMarks();
  }
  return {
    get active() {
      return active;
    },
    cancel,
    go(views, stageId, reducedMotion = false) {
      cancel();
      const targets = [];
      for (const view of views) {
        const hits = [...view.querySelectorAll(".stage-band,.stage-marker,.node")].filter(
          (element) => (element.dataset.stageId || element.dataset.stage) === stageId,
        );
        if (!hits.length) continue;
        const start = view.scrollTop,
          top = Math.min(...hits.map((element) => element.getBoundingClientRect().top)),
          end = Math.max(
            0,
            Math.min(
              start + top - view.getBoundingClientRect().top - 16,
              view.scrollHeight - view.clientHeight,
            ),
          );
        targets.push({ view, start, end });
        marked.push(...hits);
      }
      if (!targets.length) return 0;
      marked.forEach((element) => element.classList.add("stage-target"));
      active = true;
      const move = (progress) => {
        for (const { view, start, end } of targets)
          view.scrollTop = start + (end - start) * progress;
      };
      // Keep ordinary vertical sync paused through the final queued scroll events.
      const finish = () => {
        frame = requestAnimationFrame(() => {
          active = false;
          frame = null;
        });
      };
      if (reducedMotion) {
        move(1);
        finish();
      } else {
        let began;
        const step = (now) => {
          began ??= now;
          const progress = Math.min(1, (now - began) / 420);
          move(1 - (1 - progress) ** 3);
          if (progress < 1) frame = requestAnimationFrame(step);
          else finish();
        };
        frame = requestAnimationFrame(step);
      }
      timer = setTimeout(() => {
        clearMarks();
        timer = null;
      }, 1100);
      return targets.length;
    },
  };
}
