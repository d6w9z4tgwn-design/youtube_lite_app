export function savedVideo(item) {
  if (!item || !/^[A-Za-z0-9_-]{11}$/.test(item.id || '')) return null;
  return {
    id: item.id, title: String(item.title || 'タイトル不明').slice(0, 500),
    channel: String(item.channel || '').slice(0, 200),
    ...(/^UC[A-Za-z0-9_-]{22}$/.test(item.channelId || '') ? { channelId: item.channelId } : {}),
    duration: Math.max(0, Number(item.duration) || 0),
    thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${item.id}`,
  };
}
