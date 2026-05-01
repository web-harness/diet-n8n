import fs from 'fs';
import path from 'path';
import webpack from 'webpack';

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Dynamically read n8n's dependencies from its package.json
// ---------------------------------------------------------------------------
const n8nPkgPath = path.resolve(ROOT, 'node_modules/n8n/package.json');
const n8nPkg = JSON.parse(fs.readFileSync(n8nPkgPath, 'utf-8'));

/**
 * Resolve a package's main entry file by reading its package.json.
 * Falls back to index.js if no "main" field is declared.
 */
function resolvePackageMain(pkgName: string): string | null {
  const pkgDir = path.resolve(ROOT, 'node_modules', pkgName);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const mainRel = pkg.main || 'index.js';
    const mainAbs = path.resolve(pkgDir, mainRel);

    if (fs.existsSync(mainAbs)) return mainAbs;
    const withJs = mainAbs + (path.extname(mainAbs) ? '' : '.js');
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
  return pkgName.replace(/^@/, '').replace(/\//g, '__');
}

// ---------------------------------------------------------------------------
// Build the entries map
// ---------------------------------------------------------------------------
const entries: Record<string, string> = {};

entries['n8n'] = path.resolve(ROOT, 'node_modules/n8n/bin/n8n');

for (const depName of Object.keys(n8nPkg.dependencies || {})) {
  const mainFile = resolvePackageMain(depName);
  if (mainFile) {
    const key = sanitizeEntryKey(depName);
    entries[key] = mainFile;
  }
}

// ---------------------------------------------------------------------------
// Webpack configuration
// ---------------------------------------------------------------------------
const config: webpack.Configuration = {
  mode: 'development',
  devtool: 'source-map',

  entry: entries,

  target: ['web', 'es2020'],

  output: {
    path: path.resolve(ROOT, 'dist'),
    filename: 'node_modules/[name].js',
    chunkFilename: 'node_modules/[name]-[contenthash:8].js',
    library: { type: 'module' },
    chunkFormat: 'module',
    chunkLoading: 'import',
    clean: true,
  },

  experiments: {
    outputModule: true,
  },

  resolve: {
    extensions: ['.js', '.mjs', '.cjs', '.json'],
    conditionNames: ['node', 'import', 'require', 'module', 'webpack', 'development', 'browser'],
    fallback: {
      assert: false,
      async_hooks: false,
      buffer: false,
      child_process: false,
      cluster: false,
      constants: false,
      crypto: false,
      diagnostics_channel: false,
      dgram: false,
      dns: false,
      events: false,
      fs: false,
      http: false,
      http2: false,
      https: false,
      module: false,
      net: false,
      os: false,
      path: false,
      perf_hooks: false,
      process: false,
      querystring: false,
      readline: false,
      stream: false,
      string_decoder: false,
      timers: false,
      tls: false,
      tty: false,
      url: false,
      util: false,
      v8: false,
      vm: false,
      worker_threads: false,
      zlib: false,
      'node:assert': false,
      'node:async_hooks': false,
      'node:buffer': false,
      'node:child_process': false,
      'node:cluster': false,
      'node:crypto': false,
      'node:diagnostics_channel': false,
      'node:dns': false,
      'node:events': false,
      'node:fs': false,
      'node:fs/promises': false,
      'node:http': false,
      'node:https': false,
      'node:net': false,
      'node:os': false,
      'node:path': false,
      'node:perf_hooks': false,
      'node:process': false,
      'node:stream': false,
      'node:timers': false,
      'node:tls': false,
      'node:tty': false,
      'node:url': false,
      'node:util': false,
      'node:worker_threads': false,
      'node:zlib': false,
      bufferutil: false,
      canvas: false,
      pg: false,
      'pg-native': false,
      'pg-query-stream': false,
      prettier: false,
      'utf-8-validate': false,
      'word-extractor': false,
      zipfile: false,
    },
  },

  module: {
    rules: [
      {
        test: /\.node$/,
        type: 'javascript/auto',
        use: path.resolve(ROOT, 'stubs/node-addon-loader.js'),
      },
      {
        test: /\.d\.(ts|mts)$/,
        type: 'javascript/auto',
        use: path.resolve(ROOT, 'stubs/null-loader.js'),
      },
      {
        test: /\.(md|markdown|txt)$/i,
        type: 'javascript/auto',
        use: path.resolve(ROOT, 'stubs/null-loader.js'),
      },
      {
        test: /(^|[\\/])(LICENSE|README|CHANGELOG|NOTICE)(\.[a-z]+)?$/i,
        type: 'javascript/auto',
        use: path.resolve(ROOT, 'stubs/null-loader.js'),
      },
    ],
  },

  plugins: [
    new webpack.NormalModuleReplacementPlugin(
      /\.ee[/.]/,
      path.resolve(ROOT, 'stubs/ee-stub.js'),
    ),
    new webpack.NormalModuleReplacementPlugin(
      /^node:/,
      path.resolve(ROOT, 'stubs/node-stub.js'),
    ),
  ],

  optimization: {
    runtimeChunk: 'single',
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendor',
          chunks: 'all',
          priority: -10,
          reuseExistingChunk: true,
        },
      },
    },
  },
};

export default config;
