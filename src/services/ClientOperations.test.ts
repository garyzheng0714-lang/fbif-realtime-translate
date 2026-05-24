import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock i18n for clients imported through ClientOperations.
vi.mock('../locales', () => ({
  default: { t: (key: string) => key }
}));

const { ClientOperations } = await import('./ClientOperations');
const { VolcengineAST2Client } = await import('./clients/VolcengineAST2Client');
const { Provider } = await import('../types/Provider');

describe('ClientOperations Volcengine AST2 validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts the new single API key contract without a legacy access token', async () => {
    const validate = vi
      .spyOn(VolcengineAST2Client, 'validateApiKeyAndFetchModels')
      .mockResolvedValue({
        validation: { valid: true, message: 'ok', validating: false },
        models: [{ id: 'ast-v2-s2s', type: 'realtime', created: 0 }],
      });

    await ClientOperations.validateApiKeyAndFetchModels(
      'single-api-key',
      Provider.VOLCENGINE_AST2,
      ''
    );

    expect(validate).toHaveBeenCalledWith('single-api-key', '');
  });

  it('still fails loudly when the API key field is empty', async () => {
    const result = await ClientOperations.validateApiKeyAndFetchModels(
      '',
      Provider.VOLCENGINE_AST2,
      ''
    );

    expect(result.validation.valid).toBe(false);
    expect(result.validation.message).toBe('API Key is required for Doubao AST 2.0');
    expect(result.models).toEqual([]);
  });
});
