export interface YouTubeCaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  kind?: string;
  isTranslatable: boolean;
}

export interface TimelineCue {
  id: string;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText?: string;
}

export interface YouTubeTimelineResponse {
  videoId: string;
  title: string;
  sourceLanguage: string;
  tracks: YouTubeCaptionTrack[];
  cues: TimelineCue[];
}

export interface TimelineError {
  code: 'not_youtube' | 'no_video' | 'no_caption_tracks' | 'caption_fetch_failed' | 'caption_parse_failed';
  message: string;
}
