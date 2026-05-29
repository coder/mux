// Mock for .svg?react imports (Vite SVGR plugin)
const React = require("react");
module.exports = function SvgMock(props) {
  return React.createElement("svg", props);
};
