// Quality metrics from the dialog logs. On demand, no background collection,
// no storage of its own. The source is pi's own session transcripts,
// ~/.pi/agent/sessions/<slug>/*.jsonl: they carry the engineer's prompts and
// the assistant's turns alike. A session belongs to a project by the `cwd` of
// its first line, never by the directory slug — the slug is pi's own mangling
// and is not ours to guess.
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

// --- replies and turns from the pi session transcripts ---
const sessions = join(homedir(), ".pi", "agent", "sessions");
let replies = 0, caps = 0, mat = 0, turns = 0;
const MAT = /бля|хуй|хуев|нахуй|пизд|заеб|ебан|ёбан/i;
if (!existsSync(sessions)) {
  console.error(`note: no pi sessions at ${sessions} — everything counted as 0`);
} else {
  for (const dir of readdirSync(sessions, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(sessions, dir.name)).filter((f) => f.endsWith(".jsonl"))) {
      const lines = readFileSync(join(sessions, dir.name, f), "utf8").split("\n");
      let head: { type?: string; cwd?: string };
      try { head = JSON.parse(lines[0] ?? ""); } catch { continue; }
      if (head.type !== "session" || head.cwd !== project) continue;
      for (const line of lines.slice(1)) {
        if (line.includes('"role":"assistant"')) { turns++; continue; }
        if (!line.includes('"role":"user"')) continue;
        let d: { timestamp?: string; message?: { content?: { type?: string; text?: string }[] } };
        try { d = JSON.parse(line); } catch { continue; }
        if (Date.parse(d.timestamp ?? "") < since) continue;
        const text = (d.message?.content ?? [])
          .filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
        if (text.startsWith("/")) continue; // slash commands are not replies
        replies++;
        const letters = text.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
        const upper = text.replace(/[^A-ZА-ЯЁ]/g, "");
        if (letters.length > 20 && upper.length / letters.length > 0.6) caps++;
        if (MAT.test(text)) mat++;
      }
    }
  }
}

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + "%" : "—");
console.log(`metrics for ${project}, last ${days} days\n`);
console.log(`  user replies              ${replies}`);
console.log(`  assistant turns           ${turns}`);
console.log(`  replies in CAPS           ${pct(caps, replies)}   (target 0)`);
console.log(`  replies with мат          ${pct(mat, replies)}   (target 0)`);
console.log(`\n  корректировки и накладные ходы не считаются автоматически —`);
console.log(`  их оценка требует чтения транскриптов`);
