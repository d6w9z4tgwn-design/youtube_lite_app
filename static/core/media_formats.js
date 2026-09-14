export const AUDIO_TYPES = {
  m4a: 'audio/mp4; codecs="mp4a.40.2"',
  'm4a-safe': 'audio/mp4; codecs="mp4a.40.2"',
  webm: 'audio/webm; codecs="opus"',
};

export function supportedAudioFormats(audio) {
  return Object.keys(AUDIO_TYPES).filter((format) => {
    const result = audio.canPlayType(AUDIO_TYPES[format]);
    return result === 'probably' || result === 'maybe';
  });
}

export function nextAudioFormat(audio, attempted) {
  const safari = /AppleWebKit/.test(navigator.userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent);
  return supportedAudioFormats(audio).find((format) => !attempted.includes(format)
    && (safari ? format !== 'webm' : format !== 'm4a-safe')) || null;
}
