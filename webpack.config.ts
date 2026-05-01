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
    alias: {
      // Force url to wrapper — node_modules/url/ would resolve natively and
      // skip resolve.fallback, but we need our augmented stub.
      url: require.resolve('./stubs/url-wrap.mjs'),
    },
    fallback: {
      // ── Browser polyfills (shared — extracted by polyfills cacheGroup) ──
      assert: require.resolve('assert/'),
      buffer: require.resolve('buffer/'),
      console: require.resolve('console-browserify'),
      constants: require.resolve('constants-browserify'),
      crypto: require.resolve('./stubs/crypto-wrap.mjs'),
      domain: require.resolve('domain-browser'),
      events: require.resolve('events/'),
      fs: require.resolve('@zenfs/core'),
      http: require.resolve('fakettp'),
      net: require.resolve('net-browserify'),
      os: require.resolve('./stubs/os-wrap.mjs'),
      path: require.resolve('./stubs/path-wrap.mjs'),
      punycode: require.resolve('punycode/'),
      querystring: require.resolve('querystring-es3'),
      stream: require.resolve('stream-browserify'),
      string_decoder: require.resolve('string_decoder/'),
      sys: require.resolve('util/'),
      timers: require.resolve('timers-browserify'),
      url: require.resolve('./stubs/url-wrap.mjs'),
      util: require.resolve('util/'),
      vm: require.resolve('vm-browserify'),
      zlib: require.resolve('browserify-zlib'),
      // ── No browser equivalent — stay false ──
      async_hooks: false,
      child_process: false,
      cluster: false,
      diagnostics_channel: false,
      dgram: false,
      dns: false,
      http2: false,
      https: false,
      inspector: false,
      module: false,
      perf_hooks: false,
      process: false,
      readline: false,
      sqlite: false,
      tls: false,
      tty: false,
      v8: false,
      worker_threads: false,
      // ── Optional native addons — stay false ──
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
      (result) => {
        result.request = result.request.slice(5);
      },
    ),
    new webpack.NormalModuleReplacementPlugin(
      /^(assert\/strict|fs\/promises|path\/posix|stream\/promises|stream\/web|timers\/promises|util\/types)$/,
      (result) => {
        const redirects: Record<string, string> = {
          'assert/strict': require.resolve('assert/'),
          'fs/promises': require.resolve('@zenfs/core'),
          'path/posix': require.resolve('./stubs/path-wrap.mjs'),
          'stream/promises': require.resolve('stream-browserify'),
          'stream/web': require.resolve('stream-browserify'),
          'timers/promises': require.resolve('timers-browserify'),
          'util/types': require.resolve('util/'),
        };
        result.request = redirects[result.request];
      },
    ),
    new webpack.NormalModuleReplacementPlugin(
      /\/(build|Release|Debug)\/.*\.node$/,
      path.resolve(ROOT, 'stubs/ee-stub.js'),
    ),
  ],

  optimization: {
    runtimeChunk: 'single',
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        polyfills: {
          test: /[\\/]node_modules[\\/](assert|buffer|constants-browserify|crypto-browserify|domain-browser|events|@zenfs|fakettp|net-browserify|os-browserify|punycode|querystring-es3|stream-browserify|string_decoder|timers-browserify|url|util|vm-browserify|browserify-zlib)[\\/]/,
          name: 'polyfills',
          chunks: 'all',
          priority: 20,
          enforce: true,
          reuseExistingChunk: true,
        },
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
