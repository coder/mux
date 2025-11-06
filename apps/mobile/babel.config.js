const path = require('path');

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxRuntime: "automatic" }]
    ],
    plugins: [
      [
        "module-resolver",
        {
          root: ["."],
          alias: {
            "@shared": path.resolve(__dirname, "../../src"),
          },
        },
      ],
    ],
  };
};
