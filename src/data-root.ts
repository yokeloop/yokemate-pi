// Данные инженера — knowledge, journal, notes, projects.json — живут во
// вложенном репозитории home/ со своим remote: движок публичный, данные
// личные. Корень данных берётся здесь и передаётся дальше аргументом:
// функция, работающая на обоих корнях, не выводит второй сама.
import { join } from "node:path";

export const DATA_DIR = "home";

export function dataRoot(root: string): string {
  return join(root, DATA_DIR);
}
