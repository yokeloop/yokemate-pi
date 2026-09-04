// Quality metrics from the dialog logs. On demand, no background collection,
// no storage of its own. Sources survive transcript deletion:
// ~/.claude/history.jsonl keeps every user prompt.
//
// Usage: pnpm metrics [--project /path/to/project-dir] [--days N]

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2).filter((a) => a !== "--");
let project = resolve(new URL("..", import.meta.url).pathname);
let days = 30;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project") project = argv[++i];
  else if (argv[i] === "--days") days = Number(argv[++i]);
  else {
    console.error(`unknown argument ${argv[i]} — known: --project <dir>, --days <N>`);
    process.exit(1);
  }
}
const since = Date.now() - days * 864e5;

// --- user replies from history.jsonl ---
const hist = join(homedir(), ".claude", "history.jsonl");
let replies = 0, caps = 0, mat = 0, esc = 0;
const MAT = /бля|хуй|хуев|нахуй|пизд|заеб|ебан|ёбан/i;
if (existsSync(hist)) {
  for (const line of readFileSync(hist, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: { display?: string; timestamp?: number; project?: string };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.project !== project || (d.timestamp ?? 0) < since) continue;
    const text = d.display ?? "";
    if (text.startsWith("/")) continue; // slash commands are not replies
    replies++;
    const letters = text.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
    const upper = text.replace(/[^A-ZА-ЯЁ]/g, "");
    if (letters.length > 20 && upper.length / letters.length > 0.6) caps++;
    if (MAT.test(text)) mat++;
  }
}

// --- turns and interruptions from session transcripts ---
const projDir = join(homedir(), ".claude", "projects", project.replace(/\//g, "-"));
let turns = 0;
if (existsSync(projDir)) {
  for (const f of readdirSync(projDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(projDir, f), "utf8").split("\n")) {
      if (line.includes('"type":"assistant"')) turns++;
      if (line.includes("[Request interrupted by user")) esc++;
    }
  }
} else {
  console.error(`note: no transcripts at ${projDir} — turns/Esc counted as 0`);
}

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + "%" : "—");
console.log(`metrics for ${project}, last ${days} days\n`);
console.log(`  user replies              ${replies}`);
console.log(`  assistant turns           ${turns}`);
console.log(`  Esc per 100 turns         ${turns ? ((100 * esc) / turns).toFixed(1) : "—"}   (target < 5)`);
console.log(`  replies in CAPS           ${pct(caps, replies)}   (target 0)`);
console.log(`  replies with мат          ${pct(mat, replies)}   (target 0)`);
console.log(`\n  корректировки и накладные ходы не считаются автоматически —`);
console.log(`  их оценка требует чтения транскриптов`);
