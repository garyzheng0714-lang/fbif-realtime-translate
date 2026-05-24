import type { ConversationItem } from '../../services/clients';
import type { TimelineCue } from './types';

export function timelineCuesToConversationItems(cues: TimelineCue[], baseTime: number): ConversationItem[] {
  return cues
    .map((cue, index) => {
      const text = cue.translatedText?.trim();
      if (!text) return null;

      return {
        item: {
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
        } satisfies ConversationItem,
        index,
      };
    })
    .filter((entry): entry is { item: ConversationItem; index: number } => entry !== null)
    .sort((a, b) => {
      const byTime = (a.item.createdAt ?? 0) - (b.item.createdAt ?? 0);
      return byTime || a.index - b.index;
    })
    .map(({ item }) => item);
}
