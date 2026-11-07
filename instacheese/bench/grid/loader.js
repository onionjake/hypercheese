'use strict';
// Node require hook: transpiles app TypeScript and React Native's Flow
// sources with the app's own Babel preset (babel-preset-expo, configured the
// way Metro calls it for a production Android/Hermes build — including the
// React Compiler for app code, since app.json enables experiments.reactCompiler)
// and redirects native-only modules to the mocks in ./mocks.
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const NM = path.join(ROOT, 'node_modules');
const MOCKS = path.join(__dirname, 'mocks');
const babel = require(path.join(NM, '@babel/core'));
const presetExpo = require.resolve(path.join(NM, 'babel-preset-expo'));

const compilerEvents = [];

const ALIASES = {
  'react-native': path.join(MOCKS, 'react-native.js'),
  'react-native/src/private/featureflags/ReactNativeFeatureFlags': path.join(MOCKS, 'feature-flags.js'),
  'expo-image': path.join(MOCKS, 'expo-image.js'),
  '@expo/vector-icons': path.join(MOCKS, 'vector-icons.js'),
  'react-native-safe-area-context': path.join(MOCKS, 'safe-area.js'),
  '@/lib/auth': path.join(MOCKS, 'app/auth.js'),
  '@/lib/library-db': path.join(MOCKS, 'app/library-db.js'),
  '@/lib/upload-queue': path.join(MOCKS, 'app/upload-queue.js'),
  '@/lib/log': path.join(MOCKS, 'app/log.js'),
  '@/lib/mark-reminder': path.join(MOCKS, 'app/mark-reminder.js'),
  '@/components/compat-notice': path.join(MOCKS, 'app/compat-notice.js'),
};

// Relative imports inside react-native/Libraries/Lists/FlatList.js.
const FLATLIST_INTERNAL = {
  '../Components/View/View': 'View',
  '../StyleSheet/StyleSheet': 'StyleSheet',
  '../Utilities/Platform': 'Platform',
  '../Components/ScrollView/ScrollView': 'ScrollView',
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (ALIASES[request]) return ALIASES[request];
  if (request === '../../src/private/featureflags/ReactNativeFeatureFlags')
    return path.join(MOCKS, 'feature-flags.js');
  if (request.startsWith('@/')) {
    const base = path.join(SRC, request.slice(2));
    for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts', '.js']) {
      if (fs.existsSync(base + ext)) return base + ext;
    }
  }
  try {
    return origResolve.call(this, request, parent, isMain, options);
  } catch (err) {
    // Files outside the project (e.g. a `--rev` copy in the OS temp dir)
    // still resolve packages from instacheese/node_modules.
    if (!request.startsWith('.') && !path.isAbsolute(request)) {
      return origResolve.call(this, request, { ...parent, paths: [NM] }, isMain, options);
    }
    throw err;
  }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.includes('react-native/Libraries/Lists/')) {
    const which = FLATLIST_INTERNAL[request];
    if (which) return require(path.join(MOCKS, 'rn-internal.js'))[which];
  }
  return origLoad.call(this, request, parent, isMain);
};

function shouldTranspile(filename) {
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return true;
  return (
    filename.startsWith(path.join(NM, 'react-native') + path.sep) ||
    filename.startsWith(path.join(NM, '@react-native/virtualized-lists') + path.sep)
  );
}

function transpile(code, filename) {
  const isNodeModule = filename.includes(`${path.sep}node_modules${path.sep}`);
  return babel.transformSync(code, {
    filename,
    cwd: ROOT,
    babelrc: false,
    configFile: false,
    sourceMaps: 'inline',
    presets: [
      [
        presetExpo,
        {
          'react-compiler': {
            logger: {
              logEvent(file, event) {
                if (event.kind === 'CompileSuccess' || event.kind === 'CompileError' || event.kind === 'CompileSkip')
                  compilerEvents.push({
                    file: path.relative(ROOT, file),
                    kind: event.kind,
                    fn: event.fnName ?? null,
                    line: event.fnLoc?.start?.line ?? null,
                    reason: event.detail?.options?.reason ?? event.detail?.reason ?? event.reason ?? null,
                  });
              },
            },
          },
        },
      ],
    ],
    caller: {
      name: 'metro',
      bundler: 'metro',
      platform: 'android',
      engine: 'hermes',
      isDev: false,
      isServer: false,
      isNodeModule,
      supportsReactCompiler: true,
      supportsStaticESM: false,
    },
  }).code;
}

const origJs = Module._extensions['.js'];
function compileWith(module, filename) {
  const code = fs.readFileSync(filename, 'utf8');
  module._compile(transpile(code, filename), filename);
}
Module._extensions['.ts'] = compileWith;
Module._extensions['.tsx'] = compileWith;
Module._extensions['.js'] = function (module, filename) {
  if (shouldTranspile(filename)) return compileWith(module, filename);
  return origJs(module, filename);
};

module.exports = { ROOT, compilerEvents };
