import { appendFileSync } from "node:fs";
const [file, id] = process.argv.slice(2);
appendFileSync(file, `start ${id}\n`);
setTimeout(() => {
  appendFileSync(file, `end ${id}\n`);
}, 75);
