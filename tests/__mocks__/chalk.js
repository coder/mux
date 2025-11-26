// Mock chalk for Jest (chalk is ESM-only and not needed in test output)
const chalk = new Proxy(() => "", {
  get: () => chalk,
  apply: (_target, _thisArg, args) => args[0],
});

module.exports = chalk;
module.exports.default = chalk;
