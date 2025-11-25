// Mock jsdom for Jest integration tests to avoid ESM issues with parse5
// The actual web_fetch functionality works fine in production (Bun runtime)
// Integration tests don't need to test web_fetch specifically

module.exports = {
  JSDOM: class JSDOM {
    constructor(html, options) {
      this.window = {
        document: {
          title: 'Mock Document',
          body: { innerHTML: html || '' }
        }
      };
    }
  }
};
