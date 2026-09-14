export function normalizeCues(raw) {
  if (!Array.isArray(raw) || raw.length > 4000) throw new Error('字幕は4000件まで対応しています。');
  const cues = raw.map(cue => {
    const start = Number(cue.start), end = Number(cue.end);
    const text = String(cue.text || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 86400 || !text || text.length > 500) throw new Error('字幕の時間または文字数が不正です（1件500文字・24時間以内）。');
    return { start, end, text };
  }).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const cue of cues) {
    const previous = merged.at(-1);
    if (previous && previous.text === cue.text && cue.start <= previous.end + 0.2) previous.end = Math.max(previous.end, cue.end);
    else merged.push({ ...cue });
  }
  return merged.map((cue, index) => ({ ...cue, end: Math.min(cue.end, merged[index + 1]?.start ?? Infinity) })).filter(cue => cue.end > cue.start);
}

export function parseSubtitles(content) {
  if (content.length > 2 * 1024 * 1024) throw new Error('字幕ファイルは2MBまでです。');
  const stamp = value => {
    const parts = value.replace(',', '.').split(':').map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  };
  const cues = [];
  for (const block of content.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) continue;
    const match = lines[index].match(/((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/);
    if (!match) throw new Error('SRT/VTTの時刻形式を読み取れません。');
    cues.push({ start: stamp(match[1]), end: stamp(match[2]), text: lines.slice(index + 1).join(' ') });
  }
  if (!cues.length) throw new Error('SRT/VTT字幕が見つかりません。');
  return normalizeCues(cues);
}

export function cueAt(cues, time) {
  let low = 0, high = cues.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (cues[middle].start <= time) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found >= 0 && time < cues[found].end ? found : -1;
}
