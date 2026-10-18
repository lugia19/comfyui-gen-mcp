// Checks the Worker's Modal messages (packages/worker/src/modal/proto.ts) against Modal's api.proto:
// every field's number, type and repeatedness. Run after a Modal client upgrade, or when a call
// starts failing:
//   node scripts/check_modal_proto.mjs [path/to/api.proto]
// Without a path it reads modal_proto/api.proto from modal-labs/modal-client's main branch.

import { readFileSync } from "node:fs";
import * as proto from "../packages/worker/src/modal/proto.ts";

/** Every message schema proto.ts exports (Empty has no fields to check). */
const MESSAGES = Object.values(proto).filter((v) => v?.fields && Object.keys(v.fields).length);

const src = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : await (await fetch("https://raw.githubusercontent.com/modal-labs/modal-client/main/modal_proto/api.proto")).text();

/** A top-level message's body, nested blocks removed (their fields aren't the message's). */
function body(name) {
  const m = new RegExp(`\\nmessage ${name} \\{`).exec(src);
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length, out = "";
  for (; depth; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 1) out += c;
  }
  return out;
}
const enums = new Set([...src.matchAll(/\benum (\w+) \{/g)].map((m) => m[1]));

let bad = 0;
for (const schema of MESSAGES) {
  const text = body(schema.name);
  if (text === null) { console.log(`${schema.name}: not in api.proto`); bad++; continue; }
  for (const [name, [num, kind, repeated]] of Object.entries(schema.fields)) {
    const m = new RegExp(`(?:^|\\n)\\s*(repeated\\s+|optional\\s+)?([\\w.<>, ]+?)\\s+${name}\\s*=\\s*(\\d+)`).exec(text);
    if (!m) { console.log(`${schema.name}.${name}: not in api.proto`); bad++; continue; }
    const [, mod, type, n] = m;
    const want = typeof kind === "object" ? kind.name : kind;
    const typeOk = typeof kind === "object"
      ? (kind.name === "map<string,string>" ? type.replace(/\s/g, "") === "map<string,string>" : type === kind.name)
      : kind === "enum" ? enums.has(type.split(".").pop()) : type === kind;
    const repOk = Boolean(repeated) === (mod?.trim() === "repeated" || type.startsWith("map<"));
    if (Number(n) !== num || !typeOk || !repOk) {
      console.log(`${schema.name}.${name}: api.proto has ${mod ?? ""}${type} = ${n}, proto.ts ${repeated ? "repeated " : ""}${want} = ${num}`);
      bad++;
    }
  }
}
console.log(bad ? `${bad} mismatches` : `${MESSAGES.length} messages match api.proto`);
process.exit(bad ? 1 : 0);
