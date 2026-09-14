// Keep the UI timeline in seconds; never compensate by changing playback speed.
export function playerDuration(video, mediaDuration) {
  if (!video || video.isLive || video.isUpcoming) return null;
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  return Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : null;
}

export function hasDurationMismatch(video, mediaDuration) {
  if (!video || video.isLive || video.isUpcoming) return false;
  const expected = video.duration;
  if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return false;
  return Math.abs(mediaDuration - expected) > Math.max(10, expected * 0.25);
}
