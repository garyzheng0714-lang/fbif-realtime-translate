export const NO_CAPTION_TRACKS_MESSAGE = '当前视频没有可读取字幕，可切换到实时翻译';

function hasTimelineErrorCode(error: unknown): error is { code: unknown; message?: unknown } {
  return error !== null && typeof error === 'object' && 'code' in error;
}

export function getTimelineUserMessage(error: unknown): string {
  if (hasTimelineErrorCode(error) && error.code === 'no_caption_tracks') {
    return NO_CAPTION_TRACKS_MESSAGE;
  }
  return error instanceof Error ? error.message : 'Timeline session failed';
}
