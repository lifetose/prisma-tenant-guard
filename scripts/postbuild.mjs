import { writeFileSync } from "node:fs";

const markers = {
  "dist/esm/package.json": { type: "module" },
  "dist/cjs/package.json": { type: "commonjs" },
};

for (const [file, contents] of Object.entries(markers)) {
  writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
}
