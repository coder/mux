const mermaid = {
  initialize: () => {
    // Mermaid rendering is disabled for this environment.
  },
  parse(_definition: string) {
    // Mock parse method that always succeeds
    // In real mermaid, this validates the diagram syntax
    return Promise.resolve();
  },
  render(id: string, _definition: string) {
    return Promise.resolve({
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`,
      bindFunctions: () => {
        // no-op
      },
    });
  },
};

export default mermaid;
