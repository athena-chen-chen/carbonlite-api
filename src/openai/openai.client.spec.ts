describe('OpenAI client startup configuration', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    jest.resetModules();
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  it.each([undefined, '', '   '])(
    'loads without constructing a provider client when OPENAI_API_KEY is %p',
    async value => {
      if (value === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = value;

      const OpenAI = jest.fn();
      jest.doMock('openai', () => ({ __esModule: true, default: OpenAI }));
      const clientModule = await import('./openai.client');

      expect(clientModule.isOpenAiConfigured()).toBe(false);
      expect(OpenAI).not.toHaveBeenCalled();
    },
  );

  it('constructs a configured provider lazily on first use', async () => {
    process.env.OPENAI_API_KEY = 'configured-test-credential';
    const responses = { create: jest.fn() };
    const OpenAI = jest.fn().mockReturnValue({ responses });
    jest.doMock('openai', () => ({ __esModule: true, default: OpenAI }));
    const clientModule = await import('./openai.client');

    expect(clientModule.isOpenAiConfigured()).toBe(true);
    expect(OpenAI).not.toHaveBeenCalled();
    expect(clientModule.openai.responses).toBe(responses);
    expect(OpenAI).toHaveBeenCalledTimes(1);
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'configured-test-credential',
    });
  });
});
