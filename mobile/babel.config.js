const path = require("path");

const monorepoRoot = path.resolve(__dirname, "..");
const sharedAliases = {
  "@/": path.resolve(monorepoRoot, "src"),
};

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxRuntime: "automatic" }]],
    plugins: [
      [
        "module-resolver",
        {
          root: ["."],
          alias: sharedAliases,
        },
      ],
    ],
  };
};
