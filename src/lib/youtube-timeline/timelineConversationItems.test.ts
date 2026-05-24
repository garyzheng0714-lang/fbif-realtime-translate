import { describe, expect, it } from 'vitest';
import { timelineCuesToConversationItems } from './timelineConversationItems';
import type { TimelineCue } from './types';

describe('timelineCuesToConversationItems', () => {
  it('mirrors only translated timeline cues as participant assistant text items', () => {
    const cues: TimelineCue[] = [
      { id: 'a', startMs: 1000, endMs: 2000, sourceText: 'Hello', translatedText: '  你好  ' },
      { id: 'b', startMs: 2000, endMs: 3000, sourceText: 'No fallback' },
      { id: 'c', startMs: 3000, endMs: 4000, sourceText: 'Blank', translatedText: '   ' },
    ];

    expect(timelineCuesToConversationItems(cues, 10_000)).toEqual([
      {
        id: 'timeline-a',
        role: 'assistant',
        type: 'message',
        status: 'completed',
        source: 'participant',
        createdAt: 11_000,
        formatted: {
          text: '你好',
          transcript: '你好',
        },
      },
    ]);
  });

  it('sorts by cue start time while keeping equal-start items stable', () => {
    const cues: TimelineCue[] = [
      { id: 'late', startMs: 3000, endMs: 4000, sourceText: 'Late', translatedText: '晚' },
      { id: 'same-a', startMs: 1000, endMs: 1500, sourceText: 'Same A', translatedText: '同一' },
      { id: 'same-b', startMs: 1000, endMs: 1600, sourceText: 'Same B', translatedText: '同二' },
    ];

    const items = timelineCuesToConversationItems(cues, 50_000);

    expect(items.map((item) => item.id)).toEqual(['timeline-same-a', 'timeline-same-b', 'timeline-late']);
    expect(items.map((item) => item.createdAt)).toEqual([51_000, 51_000, 53_000]);
  });
});
