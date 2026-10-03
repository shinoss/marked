export function relativeAge(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  for (const [size, unit] of [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'h'], [60, 'm']]) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return unit === 'h' || unit === 'm' ? `${count}${unit} ago` : `${count} ${unit}${count === 1 ? '' : 's'} ago`;
    }
  }
}
