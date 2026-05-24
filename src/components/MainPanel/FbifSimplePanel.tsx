import React from 'react';
import { CheckCircle2, Loader, Settings2 } from 'lucide-react';
import './FbifSimplePanel.scss';

interface FbifSimplePanelProps {
  siteLabel: string;
  isSessionActive: boolean;
  isInitializing: boolean;
  isReconnecting: boolean;
  canStartSession: boolean;
  sessionDuration: string;
  latestSubtitle: string;
  initProgress: { completed: number; total: number } | null;
  onStart: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
}

const FbifSimplePanel: React.FC<FbifSimplePanelProps> = ({
  siteLabel,
  isSessionActive,
  isInitializing,
  isReconnecting,
  canStartSession,
  sessionDuration,
  latestSubtitle,
  initProgress,
  onStart,
  onStop,
  onOpenSettings,
}) => {
  const primaryLabel = isInitializing
    ? initProgress
      ? `正在连接 (${initProgress.completed}/${initProgress.total})`
      : '正在连接...'
    : isSessionActive
      ? '停止转中文'
      : canStartSession
        ? '开始听中文'
        : '先完成设置';

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
      ? '正在连接豆包语音'
      : isSessionActive
        ? `正在转中文 ${sessionDuration}`
        : canStartSession
          ? '准备就绪'
          : '需要先完成设置';

  const subtitle = latestSubtitle || '开始后这里会显示中文字幕。';

  return (
    <div className="fbif-simple-panel">
      <header className="fbif-simple-panel__header">
        <div className="fbif-simple-panel__brand">
          <div className="fbif-simple-panel__mark">中</div>
          <div>
            <h1>音频转成中文</h1>
            <p>YouTube 英文播客直接听中文</p>
          </div>
        </div>

        <div className="fbif-simple-panel__status-list" aria-label="当前状态">
          <div className="fbif-simple-panel__status-row">
            <span>当前页面</span>
            <strong><CheckCircle2 size={14} />{siteLabel}</strong>
          </div>
          <div className="fbif-simple-panel__status-row">
            <span>播放模式</span>
            <strong><CheckCircle2 size={14} />只听中文</strong>
          </div>
          <div className="fbif-simple-panel__status-row">
            <span>服务状态</span>
            <strong className={isSessionActive || canStartSession ? '' : 'is-warning'}>
              {isInitializing && <Loader size={14} className="fbif-simple-panel__spin" />}
              {connectionText}
            </strong>
          </div>
        </div>
      </header>

      <main className="fbif-simple-panel__body">
        <section className="fbif-simple-panel__primary-card">
          <button
            className={`fbif-simple-panel__primary ${isSessionActive ? 'is-stop' : ''}`}
            type="button"
            onClick={handlePrimaryClick}
            disabled={isInitializing}
          >
            {primaryLabel}
          </button>
          <p>点一次就开始。英文原声默认静音，只播放中文配音。</p>
        </section>

        <section className="fbif-simple-panel__subtitle-card" aria-label="中文字幕">
          <div className="fbif-simple-panel__subtitle-meta">
            <span>中文字幕</span>
            <span>延迟约 3 秒</span>
          </div>
          <div className={`fbif-simple-panel__subtitle ${latestSubtitle ? '' : 'is-empty'}`}>
            {subtitle}
          </div>
          <p>英文原文已隐藏。需要时可以临时查看。</p>
        </section>

        <section className="fbif-simple-panel__steps" aria-label="使用步骤">
          <div className="fbif-simple-panel__step">
            <span>1</span>
            <div><strong>打开英文视频</strong><p>比如 YouTube 播客或访谈。</p></div>
          </div>
          <div className="fbif-simple-panel__step">
            <span>2</span>
            <div><strong>点插件图标</strong><p>面板会自动识别当前页面。</p></div>
          </div>
          <div className="fbif-simple-panel__step">
            <span>3</span>
            <div><strong>开始听中文</strong><p>不用盯字幕，字幕只是辅助确认。</p></div>
          </div>
        </section>
      </main>

      <footer className="fbif-simple-panel__footer">
        <span>{canStartSession ? '豆包语音已配置' : '需要配置豆包语音'}</span>
        <button type="button" onClick={onOpenSettings}>
          <Settings2 size={14} />
          高级设置
        </button>
      </footer>
    </div>
  );
};

export default FbifSimplePanel;
