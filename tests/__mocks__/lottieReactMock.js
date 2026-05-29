const React = require("react");

// lottie-web probes canvas on import (fillStyle on a 2d context), which crashes
// in happy-dom/jsdom. Mock the entire lottie-react module to avoid loading it.
module.exports = {
  __esModule: true,
  default: function LottieMock(props) {
    return React.createElement("div", { "data-testid": "lottie-mock", ...props });
  },
};
