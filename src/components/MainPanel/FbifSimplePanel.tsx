import React from 'react';
import './FbifSimplePanel.scss';

interface FbifSimplePanelProps {
  siteLabel: string;
  translationMode: 'timeline' | 'streaming';
  targetLanguageLabel: string;
  timelineStatus: string;
  timelineCueCount: number;
  isSessionActive: boolean;
  isInitializing: boolean;
  isReconnecting: boolean;
  canStartSession: boolean;
  sessionDuration: string;
  latestSubtitle: string;
  initProgress: { completed: number; total: number } | null;
  onSetMode: (mode: 'timeline' | 'streaming') => void;
  onEnterSubtitleOverlay: () => void;
  onStart: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
}

const FbifSimplePanel: React.FC<FbifSimplePanelProps> = ({
  siteLabel,
  translationMode,
  targetLanguageLabel,
  timelineStatus,
  timelineCueCount,
  isSessionActive,
  isInitializing,
  isReconnecting,
  canStartSession,
  sessionDuration,
  latestSubtitle,
  initProgress,
  onSetMode,
  onEnterSubtitleOverlay,
  onStart,
  onStop,
  onOpenSettings,
}) => {
  const primaryLabel = isInitializing
    ? initProgress
      ? `连接中 ${initProgress.completed}/${initProgress.total}`
      : '连接中'
    : isSessionActive
      ? '停止'
      : canStartSession
        ? '开始'
        : '设置';

  const handlePrimaryClick = () => {
    if (isInitializing) return;
    if (isSessionActive) {
      onStop();
      return;
    }
    if (!canStartSession) {
      onOpenSettings();
      return;
    }
    onStart();
  };

  const connectionText = isReconnecting
    ? '正在重新连接'
    : isInitializing
      ? '正在连接'
      : isSessionActive
        ? `转中文 ${sessionDuration}`
        : canStartSession
          ? '就绪'
          : '需设置';

  const topbarStatus = translationMode === 'timeline' ? timelineStatus : connectionText;
  const subtitle = latestSubtitle || '暂无中文字幕';
  const cueCountText = timelineCueCount > 0 ? `${timelineCueCount} 条` : '等待';
  const modeSwitchDisabled = isSessionActive || isInitializing;
  const modeSwitchTitle = modeSwitchDisabled ? '运行中不能切换模式' : undefined;

  return (
    <div className="fbif-simple-panel">
      <header className="fbif-simple-panel__topbar" aria-label="当前状态">
        <div className="fbif-simple-panel__topbar-item" title={siteLabel}>
          {siteLabel}
        </div>
        <div className="fbif-simple-panel__topbar-item is-center" title={targetLanguageLabel}>
          {targetLanguageLabel}
        </div>
        <div className="fbif-simple-panel__topbar-item is-right" title={topbarStatus}>
          {topbarStatus}
        </div>
      </header>

      <main className="fbif-simple-panel__body">
        <button
          className={`fbif-simple-panel__primary ${isSessionActive ? 'is-stop' : ''}`}
          type="button"
          onClick={handlePrimaryClick}
          disabled={isInitializing}
        >
          {primaryLabel}
        </button>

        <div className="fbif-simple-panel__quick-controls" aria-label="快速控制">
          <button
            type="button"
            className={translationMode === 'timeline' ? 'is-active' : ''}
            onClick={() => onSetMode('timeline')}
            aria-pressed={translationMode === 'timeline'}
            aria-disabled={modeSwitchDisabled}
            disabled={modeSwitchDisabled}
            title={modeSwitchTitle}
          >
            视频同步
          </button>
          <button
            type="button"
            className={translationMode === 'streaming' ? 'is-active' : ''}
            onClick={() => onSetMode('streaming')}
            aria-pressed={translationMode === 'streaming'}
            aria-disabled={modeSwitchDisabled}
            disabled={modeSwitchDisabled}
            title={modeSwitchTitle}
          >
            实时翻译
          </button>
          <button
            type="button"
            onClick={onEnterSubtitleOverlay}
            disabled={!isSessionActive}
          >
            字幕浮层
          </button>
        </div>

        <section className="fbif-simple-panel__subtitle-log" aria-label="中文字幕流水">
          <div className="fbif-simple-panel__subtitle-meta">
            <span>中文字幕流水</span>
            <span>{cueCountText}</span>
          </div>
          <div
            className={`fbif-simple-panel__subtitle ${latestSubtitle ? '' : 'is-empty'}`}
            aria-live="polite"
          >
            {subtitle}
          </div>
        </section>
      </main>

      <footer className="fbif-simple-panel__footer">
        <button type="button" onClick={onOpenSettings}>
          设置
        </button>
      </footer>
    </div>
  );
};

export default FbifSimplePanel;
