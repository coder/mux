// Mock the highlight worker for Jest tests
module.exports = {
  highlightCode: async (code, lang) => {
    // Return unhighlighted code as fallback
    return `<pre><code>${code}</code></pre>`;
  },
};
