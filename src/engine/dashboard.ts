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
  // The npm package ships the HTML prebuilt by scripts/build-package.ts
  // instead of src/dashboard.
  const source = join(import.meta.dir, "..", "dashboard", "index.html");
  if (!(await Bun.file(source).exists())) {
    return Bun.file(join(import.meta.dir, "..", "..", "dist", "lib", "dashboard.html")).text();
  }
  // Built at runtime so the bundler cannot resolve it: binaries embed the
  // finished HTML and must not carry Tailwind (~800 KB).
  const pluginName = ["bun-plugin", "tailwind"].join("-");
  const tailwind = (await import(pluginName)).default;
  const result = await Bun.build({
    entrypoints: [source],
    compile: true,
    target: "browser",
    minify: true,
    plugins: [tailwind],
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
