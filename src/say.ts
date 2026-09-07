import { sendReport } from "./inbox.ts";

const USAGE = 'usage: say [--to <pane>] "<текст>"';

const argv = process.argv.slice(2).filter((a) => a !== "--");
let to: string | undefined;
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--to") to = argv[++i];
  else words.push(argv[i]);
}

const text = words.join(" ").trim();
if (!text || (to !== undefined && !to)) {
  console.error(USAGE);
  process.exit(1);
}

const r = await sendReport(process.env, process.getuid!(), text, to);
console.log(r.line);
process.exit(r.ok ? 0 : 1);
