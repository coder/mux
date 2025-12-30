// Transform .md files to their string content for Jest
const fs = require("fs");
const path = require("path");

module.exports = {
  process(sourceText, sourcePath) {
    return {
      code: `module.exports = ${JSON.stringify(sourceText)};`,
    };
  },
};
