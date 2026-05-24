import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('FBIF Chinese UI defaults', () => {
  it('loads Simplified Chinese resources immediately so the app does not start in English', async () => {
    vi.resetModules();

    const { default: i18n } = await import('./index');

    expect(i18n.language).toBe('zh_CN');
    expect(i18n.t('common.settings')).toBe('设置');
  });

  it('uses Chinese popup copy even when Chrome resolves an English extension locale', () => {
    const loadMessages = (locale: string) => JSON.parse(
      readFileSync(join(process.cwd(), 'extension', '_locales', locale, 'messages.json'), 'utf8')
    );
    const zhCN = loadMessages('zh_CN');

    for (const locale of ['en', 'en_US', 'en_GB', 'en_AU']) {
      const messages = loadMessages(locale);
      expect(messages.openSokuji.message).toBe(zhCN.openSokuji.message);
      expect(messages.clickToStart.message).toBe(zhCN.clickToStart.message);
      expect(messages.quickStart.message).toBe(zhCN.quickStart.message);
    }
  });

  it('keeps the Simplified Chinese side panel locale complete enough to avoid English fallback text', () => {
    const loadTranslation = (locale: string) => JSON.parse(
      readFileSync(join(process.cwd(), 'src', 'locales', locale, 'translation.json'), 'utf8')
    );
    const flatten = (value: unknown, prefix = ''): string[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
      return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
    };

    const enKeys = flatten(loadTranslation('en')).filter(Boolean);
    const zhKeys = new Set(flatten(loadTranslation('zh_CN')).filter(Boolean));

    expect(enKeys.filter((key) => !zhKeys.has(key))).toEqual([]);
  });
});
