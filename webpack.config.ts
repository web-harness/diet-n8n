/// <reference types="node" />
/// <reference types="webpack" />

import fs from "node:fs";
import path from "node:path";
import webpack from "webpack";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Dynamically read n8n's dependencies from its package.json
// ---------------------------------------------------------------------------
const n8nPkgPath = path.resolve(ROOT, "node_modules/n8n/package.json");
const n8nPkg = JSON.parse(fs.readFileSync(n8nPkgPath, "utf-8"));

/**
 * Resolve a package's main entry file by reading its package.json.
 * Falls back to index.js if no "main" field is declared.
 */
function resolvePackageMain(pkgName: string): string | null {
  const pkgDir = path.resolve(ROOT, "node_modules", pkgName);
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    const mainRel = pkg.main || "index.js";
    const mainAbs = path.resolve(pkgDir, mainRel);

    if (fs.existsSync(mainAbs)) return mainAbs;
    const withJs = mainAbs + (path.extname(mainAbs) ? "" : ".js");
    if (fs.existsSync(withJs)) return withJs;
    return null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a package name into a safe webpack entry / chunk key.
 * "@scope/name"  → "scope__name"
 * "name"         → "name"
 */
function sanitizeEntryKey(pkgName: string): string {
  return pkgName.replace(/^@/, "").replace(/\//g, "__");
}

// ---------------------------------------------------------------------------
// Build the entries map
// ---------------------------------------------------------------------------
const entries: webpack.EntryObject = {};

entries.n8n = {
  import: [path.resolve(ROOT, "node_modules/n8n/bin/n8n")],
  filename: "n8n.mjs",
};

for (const depName of Object.keys(n8nPkg.dependencies || {})) {
  const mainFile = resolvePackageMain(depName);
  if (mainFile) {
    const key = sanitizeEntryKey(depName);
    entries[key] = { import: [mainFile] };
  }
}

{
  const mainFile = resolvePackageMain("prettier");
  if (mainFile) {
    entries.prettier = { import: [mainFile] };
  }
}

// ---------------------------------------------------------------------------
// Webpack configuration — Node only
// ---------------------------------------------------------------------------
const config: webpack.Configuration = {
  mode: "development",
  devtool: "source-map",

  entry: entries,

  target: "node",

  experiments: {
    outputModule: true,
  },

  output: {
    path: path.resolve(ROOT, "dist"),
    filename: "node_modules/[name].mjs",
    chunkFilename: "node_modules/[name]-[contenthash:8].mjs",
    library: { type: "module" },
    clean: true,
  },

  // Treat Node built-ins as external — they come from the Node runtime,
  // not from bundled code.  npm packages go into dist/node_modules.
  externalsPresets: { node: true },
  externalsType: "module",

  resolve: {
    extensions: [".js", ".mjs", ".cjs", ".json"],
    conditionNames: ["import", "node", "require"],
  },

  module: {
    rules: [
      // Dependencies calling fs.readFileSync(__dirname + path) are invisible
      // to webpack's static analysis.  Convert them to require() calls so the
      // .wasm asset rule below can emit the file.
      {
        test: /\.js$/,
        include: /node_modules/,
        enforce: "pre",
        use: {
          loader: "string-replace-loader",
          options: {
            multiple: [
              {
                // brotli-wasm: convert readFileSync / __dirname to static require() so webpack
                // can emit the .wasm asset.
                search:
                  /const\s+path\s*=\s*require\(['"]path['"]\)\s*\.\s*join\s*\(\s*__dirname\s*,\s*['"]([^'"]+\.wasm)['"]\s*\)\s*;\s*const\s+bytes\s*=\s*require\(['"]fs['"]\)\s*\.\s*readFileSync\s*\(\s*path\s*\)\s*;/g,
                replace:
                  'const bytes = require("fs").readFileSync(require("./$1"));',
              },
              {
                // sqlite3: convert bindings() dynamic loading to static require() so
                // webpack's .node asset rule can emit the native addon.
                search:
                  /module\.exports\s*=\s*require\(['"]bindings['"]\)\s*\(\s*['"]node_sqlite3\.node['"]\s*\)/g,
                replace:
                  'module.exports = require("../build/Release/node_sqlite3.node")',
              },
            ],
          },
        },
      },
      // Cannot use content-hash filenames for .wasm — runtime callers do
      // fs.readFileSync(__dirname + '/original_name.wasm') and skip webpack's
      // module resolution.
      {
        test: /\.wasm$/,
        type: "asset/resource",
        generator: {
          filename: "node_modules/[name][ext]",
        },
      },
      // Prebuilt native addons.  Keep only linux-x64 binaries; stub
      // the rest so packages (Sentry) that statically require() every
      // platform variant don't cause webpack parse errors.
      {
        test: /\.node$/,
        oneOf: [
          {
            resource: (absPath: string): boolean =>
              !/(?:^|[\\/-])(?:darwin|win32|freebsd|sunos|aix|android|linux-arm64)(?:[\\/.-]|$)/i.test(
                absPath,
              ),
            type: "asset/resource",
            generator: {
              filename: "node_modules/[name]-[contenthash:8][ext]",
            },
          },
          {
            use: path.resolve(ROOT, "stubs/null-loader.js"),
          },
        ],
      },
      // Type declaration files — not needed at runtime
      {
        test: /\.d\.(ts|mts)$/,
        type: "javascript/auto",
        use: path.resolve(ROOT, "stubs/null-loader.js"),
      },
      // Text / documentation files that get require()d accidentally
      {
        test: /\.(md|markdown|txt)$/i,
        type: "javascript/auto",
        use: path.resolve(ROOT, "stubs/null-loader.js"),
      },
      {
        test: /(^|[\\/])(LICENSE|README|CHANGELOG|NOTICE)(\.[a-z]+)?$/i,
        type: "javascript/auto",
        use: path.resolve(ROOT, "stubs/null-loader.js"),
      },
    ],
  },

  plugins: [
    // n8n Enterprise Edition features — replace with empty stub
    // (unlicensed; keep regardless of target)
    new webpack.NormalModuleReplacementPlugin(
      /\.ee[/.]/,
      path.resolve(ROOT, "stubs/ee-stub.js"),
    ),
    // Strip node: prefix from built-in imports so they resolve correctly
    // as externals (e.g. node:fs → fs)
    new webpack.NormalModuleReplacementPlugin(/^node:/, (result) => {
      result.request = result.request.slice(5);
    }),
  ],

  optimization: {
    runtimeChunk: "single",
    splitChunks: {
      chunks: "all",
      // Prevent webpack from creating an extra vendor chunk that
      // collapses all of node_modules — we want per-package entries.
      cacheGroups: {
        defaultVendors: false,
        default: false,
      },
    },
  },
};

export default config;
