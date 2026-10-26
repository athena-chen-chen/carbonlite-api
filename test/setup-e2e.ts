jest.mock('../src/openai/openai.client', () => ({
  openai: {
    responses: {
      create: jest.fn().mockRejectedValue(
        new Error('Unexpected external-provider request in deterministic E2E'),
      ),
    },
  },
}));
