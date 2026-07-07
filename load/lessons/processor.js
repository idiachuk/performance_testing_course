// Custom processor for the file-upload lesson.
// Artillery loads processors as CommonJS modules: use require() and
// module.exports, not ES Module import/export.
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

function setupMultipartFormData(requestParams, context, ee, next) {
  const form = new FormData();
  form.append("file", fs.createReadStream(path.join(__dirname, "sample.txt")));
  requestParams.body = form;
  return next();
}

module.exports = { setupMultipartFormData };
