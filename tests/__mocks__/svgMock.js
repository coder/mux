// Mock SVG imports with ?react query string (vite-plugin-svgr style)
// Returns a simple React component that renders an empty span
const React = require("react");

const SvgMock = React.forwardRef((props, ref) =>
  React.createElement("span", { ...props, ref, "data-testid": "svg-mock" })
);

SvgMock.displayName = "SvgMock";

module.exports = SvgMock;
module.exports.default = SvgMock;
module.exports.ReactComponent = SvgMock;
