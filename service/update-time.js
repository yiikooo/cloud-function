const fs = require("fs");

function updateTime() {
  const updateTime = new Date().toISOString();
  fs.writeFileSync("../public/time.txt", updateTime);
}

module.exports = updateTime;
