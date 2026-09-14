export function text(parent, value, tag = 'p') {
  const node = document.createElement(tag);
  node.textContent = value;
  parent.append(node);
  return node;
}
export function button(parent, label, action) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'ghost module-button';
  node.textContent = label;
  node.addEventListener('click', () => Promise.resolve().then(action).catch((error) => {
    console.error(error);
    node.title = error.message;
  }));
  parent.append(node);
  return node;
}
export function listen(ctx, target, event, fn) {
  target.addEventListener(event, fn);
  ctx.onCleanup(() => target.removeEventListener(event, fn));
}
function createPanel(ctx, name, description) {
  const dialog = document.createElement('dialog');
  dialog.className = 'audio-panel';
  dialog.setAttribute('aria-label', name);
  const header = document.createElement('div');
  header.className = 'dialog-head';
  text(header, name, 'h2');
  button(header, '閉じる', () => dialog.close());
  dialog.append(header);
  if (description) text(dialog, description).className = 'module-note';
  const body = document.createElement('div');
  body.className = 'audio-panel-body';
  dialog.append(body);
  document.body.append(dialog);
  const open = () => { if (!dialog.open && dialog.isConnected) dialog.showModal(); };
  ctx.onCleanup(() => { dialog.close(); dialog.remove(); });
  return { body, dialog, open };
}
export function panel(ctx, name, description = '') {
  const group = ctx.ui.createControlGroup('');
  const { body, dialog, open } = createPanel(ctx, name, description);
  ctx.registerControl('openPanel', open);
  const opener = button(group, name, open);
  opener.setAttribute('aria-haspopup', 'dialog');
  return { body, dialog, opener };
}
// Reuse the inline controls from the player; never duplicate controls or move its audio element.
export function inlinePanel(ctx, group, name, description = '') {
  const { body, dialog, open } = createPanel(ctx, name, description);
  body.classList.add('audio-inline-controls');
  let placeholder = null;
  const restore = () => {
    if (placeholder?.parentNode) placeholder.replaceWith(group);
    placeholder = null;
  };
  ctx.registerControl('openPanel', () => {
    if (dialog.open || !group.isConnected || !dialog.isConnected) return;
    restore(); // A close event may still be queued when the panel is reopened.
    placeholder = document.createComment('module controls return here');
    group.before(placeholder);
    body.append(group);
    try { open(); } catch (error) { restore(); throw error; }
  });
  const onClose = () => { if (!dialog.open) restore(); };
  dialog.addEventListener('close', onClose);
  ctx.onCleanup(() => {
    dialog.removeEventListener('close', onClose);
    restore();
  });
  return { body, dialog };
}
export function slider(ctx, parent, key, label, min, max, step, initial, apply, unit = '') {
  const row = document.createElement('label');
  row.className = 'audio-slider';
  text(row, label, 'span');
  const output = document.createElement('output');
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step });
  input.setAttribute('aria-label', label);
  input.dataset.control = key;
  row.append(output, input);
  parent.append(row);
  const set = (raw) => {
    const number = Number(raw);
    const value = Math.max(min, Math.min(max, Number.isFinite(number) ? number : initial));
    input.value = String(value);
    const actual = Number(input.value);
    output.textContent = `${Number(actual.toFixed(2))}${unit}`;
    ctx.storage.set(key, actual);
    apply(actual);
  };
  input.addEventListener('input', () => set(input.value));
  ctx.registerControl(key, set);
  set(ctx.storage.get(key, initial));
  return { input, set };
}
export function toggle(ctx, parent, key, label, initial, apply) {
  const row = document.createElement('label');
  row.className = 'audio-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('aria-label', label);
  row.append(input, document.createTextNode(label));
  parent.append(row);
  const set = (value) => { input.checked = Boolean(value); ctx.storage.set(key, input.checked); apply(input.checked); };
  input.addEventListener('change', () => set(input.checked));
  ctx.registerControl(key, set);
  set(ctx.storage.get(key, initial));
  return { input, set };
}
export function effect(ctx, id, nodes, order) {
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  const unregister = ctx.audioEngine.registerEffect(id, nodes[0], order, nodes.at(-1));
  ctx.onCleanup(() => { unregister(); nodes.forEach((node) => node.disconnect()); });
}
export function smooth(param, value, context) {
  param.setTargetAtTime(value, context.currentTime, 0.02);
}
export function frameLoop(ctx, tick) {
  let frame;
  let last = 0;
  const run = (now) => {
    if (now - last > 40) { tick(now); last = now; }
    frame = requestAnimationFrame(run);
  };
  frame = requestAnimationFrame(run);
  ctx.onCleanup(() => cancelAnimationFrame(frame));
}
export function timeLabel(time) {
  const seconds = Math.max(0, Math.floor(Number(time) || 0));
  return `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
