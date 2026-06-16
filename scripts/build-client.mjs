import * as esbuild from "esbuild";
import { copyFile, cp, mkdir, watch as fsWatch } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "public";

await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  target: ["es2022"],
  sourcemap: true,
  logLevel: "info",
};

const appOpts = { ...common, entryPoints: ["src/client/main.ts"], outfile: "public/app.js" };
const workletOpts = {
  ...common,
  entryPoints: ["src/client/audio/worklet.ts"],
  outfile: "public/worklet.js",
};

async function copyAssets() {
  await copyFile("src/client/index.html", "public/index.html");
  await copyFile("src/client/styles.css", "public/styles.css");
  await cp("src/client/assets", "public/assets", { recursive: true });
  await copyFile("src/client/favicon.png", "public/favicon.png").catch(() => {});
}

if (watch) {
  const ctxApp = await esbuild.context(appOpts);
  const ctxWorklet = await esbuild.context(workletOpts);
  await ctxApp.watch();
  await ctxWorklet.watch();
  await copyAssets();
  console.log("[build] watching client (app + worklet + assets)…");
  (async () => {
    try {
      for await (const ev of fsWatch("src/client", { recursive: true })) {
        if (ev.filename && /\.(html|css|svg|png)$/.test(ev.filename)) {
          await copyAssets().catch(() => {});
        }
      }
    } catch {
      /* watcher closed */
    }
  })();
} else {
  await esbuild.build(appOpts);
  await esbuild.build(workletOpts);
  await copyAssets();
  console.log("[build] client built to public/");
}
