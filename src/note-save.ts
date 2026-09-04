// The blessed save for the /note pane: commit and push notes/ alone, through
// the same syncPush that carries the journal. Raw git is cut by the guard in
// that pane; this command is the one legal write path out of it. No stamp
// check — it is legal from the note pane (that is what it is for) and from
// the main chat alike. syncPush's contract holds: a network failure is one
// line on stderr, exit 0.
import { resolve } from "node:path";
import { syncPush } from "./git-sync.ts";

export function noteSave(root: string, topic: string): void {
  syncPush(root, topic ? `заметка ${topic}` : "заметка", ["notes"]);
}

if (import.meta.filename === process.argv[1]) {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const topic = process.argv.slice(2).filter((a) => a !== "--").join(" ");
  noteSave(root, topic);
  console.log(`notes/ → закоммичено и запушено («${topic ? `заметка ${topic}` : "заметка"}»)`);
}
