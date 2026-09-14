// Preview while dragging; commit only the final position on release/change.
export function bindSeekSlider(slider, { guard, duration, preview }) {
  let dragging = false;
  let changed = false;
  const target = () => {
    const total = duration();
    return total === null ? null : Number(slider.value) / 1000 * total;
  };
  const commit = () => {
    if (!dragging && !changed) return;
    const time = target();
    dragging = false;
    changed = false;
    if (time === null) guard.reset();
    else guard.endScrub(time);
  };
  slider.addEventListener('pointerdown', () => {
    if (target() === null) return;
    dragging = true;
    guard.beginScrub();
  });
  slider.addEventListener('input', () => {
    const time = target();
    if (time === null) return;
    if (!dragging && !changed) guard.beginScrub();
    changed = true;
    preview(time);
  });
  slider.addEventListener('change', commit);
  // Runs after the browser's final range input event, including release outside.
  window.addEventListener('pointerup', () => { if (dragging) commit(); });
  window.addEventListener('pointercancel', () => { if (dragging) commit(); });
  slider.addEventListener('blur', commit);
  window.addEventListener('blur', commit);
  return { isPreviewing: () => dragging || changed };
}
