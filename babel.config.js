module.exports = {
  presets: [
    [
      "@babel/preset-env",
      {
        targets: {
          node: "current",
        },
        modules: "commonjs",
      },
    ],
    [
      "@babel/preset-typescript",
      {
        allowDeclareFields: true,
      },
    ],
    [
      "@babel/preset-react",
      {
        runtime: "automatic",
      },
    ],
  ],
  plugins: [
    // Transform import.meta.env to process.env for Jest compatibility
    "babel-plugin-transform-vite-meta-env",
  ],
};
