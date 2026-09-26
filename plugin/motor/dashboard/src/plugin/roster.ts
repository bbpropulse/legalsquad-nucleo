import type { Agent } from "../types/state";

// CSV do squad-party: aspas, vírgulas e quebras de linha dentro dos campos.
export function parseParty(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false;
  const input = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(value);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (quoted) return []; // não inventar equipe a partir de CSV truncado
  row.push(value);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

export function squadRoster(csv: string, yamlAgents: unknown): Agent[] {
  const [header = [], ...rows] = parseParty(csv);
  const col = (name: string) => header.findIndex((v) => v.trim() === name);
  const fromParty =
    col("id") >= 0
      ? rows.map((r) => ({
          id: r[col("id")],
          name: r[col("name")],
          icon: r[col("icon")],
        }))
      : [];
  const candidates = fromParty.length
    ? fromParty
    : Array.isArray(yamlAgents)
      ? yamlAgents
      : [];
  const agents: Agent[] = [];
  for (const item of candidates) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id.trim()
    )
      continue;
    const id = item.id.trim();
    if (agents.some((a) => a.id === id)) continue;
    const i = agents.length;
    agents.push({
      id,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : id,
      icon: typeof item.icon === "string" ? item.icon : "",
      status: "idle",
      desk: { col: (i % 3) + 1, row: Math.floor(i / 3) + 1 },
    });
  }
  return agents;
}
