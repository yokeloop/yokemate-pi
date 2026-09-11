const mode = process.argv.slice(2).filter((arg) => arg !== "--")[0];
const ticket = process.argv.slice(2).filter((arg) => arg !== "--")[1];
if ((mode !== "do" && mode !== "ship") || !ticket) {
  console.error("usage: close-mode <ship|do> <TICKET>");
  process.exit(1);
}
console.log(`${ticket} ${mode}: background run is owned by parent runtime; no tab to close`);
