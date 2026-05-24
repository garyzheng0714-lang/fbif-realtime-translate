import type { ConversationItem } from '../../services/clients';
import type { TimelineCue } from './types';

type TimelineConversationEntry = { item: ConversationItem; index: number };

export function timelineCuesToConversationItems(cues: TimelineCue[], baseTime: number): ConversationItem[] {
  return cues
    .map<TimelineConversationEntry | null>((cue, index) => {
      const text = cue.translatedText?.trim();
      if (!text) return null;

      const item: ConversationItem = {
        id: `timeline-${cue.id}`,
        role: 'assistant',
        type: 'message',
        status: 'completed',
        source: 'participant',
        createdAt: baseTime + cue.startMs,
        formatted: {
          text,
          transcript: text,
        },
      };

      return {
        item,
        index,
      };
    })
    .filter((entry): entry is TimelineConversationEntry => entry !== null)
    .sort((a, b) => {
      const byTime = (a.item.createdAt ?? 0) - (b.item.createdAt ?? 0);
      return byTime || a.index - b.index;
    })
    .map(({ item }) => item);
}
