import path from 'path';
import webpack from 'webpack';

const ROOT = process.cwd();

const config: webpack.Configuration = {
  mode: 'development',
  devtool: 'source-map',

  entry: path.resolve(ROOT, 'node_modules/n8n/bin/n8n'),

  target: ['web', 'es2020'],

  output: {
    path: path.resolve(ROOT, 'dist'),
    filename: 'n8n-bundle.js',
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
    extensions: ['.js', '.ts', '.mjs', '.cjs', '.json'],
    fallback: {
      assert: false,
      buffer: false,
      child_process: false,
      constants: false,
      crypto: false,
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
      'node:crypto': false,
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
    },
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
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendor',
          chunks: 'all',
          filename: 'node_modules/vendor-[contenthash:8].js',
        },
      },
    },
  },
};

export default config;
