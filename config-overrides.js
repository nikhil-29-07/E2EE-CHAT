// config-overrides.js
const webpack = require("webpack");
const path = require("path");

module.exports = function override(config, env) {
  config.resolve = config.resolve || {};

  // ✅ Polyfill only SAFE Node modules (no process!)
  config.resolve.fallback = Object.assign({}, config.resolve.fallback, {
    buffer: require.resolve("buffer/"),
    crypto: require.resolve("crypto-browserify"),
    stream: require.resolve("stream-browserify"),
    vm: require.resolve("vm-browserify"),
    assert: require.resolve("assert/"),
    http: require.resolve("stream-http"),
    https: require.resolve("https-browserify"),
    os: require.resolve("os-browserify/browser"),
    url: require.resolve("url/"),
    // ❌ DO NOT POLYFILL process/browser (react-router breaks)
  });

  // ✅ Provide Buffer only (safe)
  config.plugins.push(
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
    })
  );

  // ✅ Define minimal process.env (fixes libs needing it)
  config.plugins.push(
    new webpack.DefinePlugin({
      "process.env": JSON.stringify({
        NODE_ENV: env,
      }),
    })
  );

  return config;
};
