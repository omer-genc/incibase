// The admin dashboard is a React app bundled into one self-contained HTML
// file. Standalone binaries and built apps carry it pre-built; running from
// source builds it on first request.
import { join } from "node:path";

let embedded: string | null = null;
let building: Promise<string> | null = null;

export function setEmbeddedDashboard(html: string) {
  embedded = html;
}

export async function buildDashboardHtml(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "dashboard", "index.html")],
    compile: true,
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success || !result.outputs[0]) {
    throw new Error(`Dashboard build failed:\n${result.logs.map(String).join("\n")}`);
  }
  return result.outputs[0].text();
}

export function dashboardHtml(): Promise<string> {
  if (embedded) return Promise.resolve(embedded);
  building ??= buildDashboardHtml().catch((err) => {
    building = null;
    throw err;
  });
  return building;
}
