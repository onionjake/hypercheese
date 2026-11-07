'use strict';
// Stand-in for the `react-native` package. Host primitives render custom DOM
// elements carrying their props (see dom-shim.js); FlatList is React Native's
// REAL FlatList + @react-native/virtualized-lists (transpiled by loader.js),
// so windowing, CellRenderer memoization and numColumns row grouping behave
// exactly as on device.
const React = require('react');
const { counters } = require('../counters');
const h = React.createElement;

const state = { lastAlert: null, colorScheme: 'light' };
const WINDOW = { width: 412, height: 915, scale: 2.625, fontScale: 1 };

const View = React.forwardRef(function View(props, ref) {
  counters.view++;
  return h('rn-view', { ref, _p: props }, props.children);
});

const Text = React.forwardRef(function Text(props, ref) {
  counters.text++;
  return h('rn-text', { ref, _p: props }, props.children);
});

// RN's Pressable is memo(Pressable) with internal state + pressability hooks.
const Pressable = React.memo(
  React.forwardRef(function Pressable(props, ref) {
    counters.pressable++;
    if (props.accessibilityRole === 'checkbox') counters.cell++;
    const [pressed] = React.useState(false);
    const config = React.useMemo(
      () => ({ onPress: props.onPress, onLongPress: props.onLongPress, disabled: props.disabled }),
      [props.onPress, props.onLongPress, props.disabled]
    );
    const style = typeof props.style === 'function' ? props.style({ pressed }) : props.style;
    const children =
      typeof props.children === 'function' ? props.children({ pressed }) : props.children;
    return h('rn-view', { ref, _p: { ...props, style, __config: config } }, children);
  })
);

function ActivityIndicator(props) {
  return h('rn-view', { _p: props });
}

class ScrollView extends React.Component {
  static Context = React.createContext(null);
  scrollTo() {}
  scrollToEnd() {}
  flashScrollIndicators() {}
  getScrollResponder() {
    return this;
  }
  getScrollableNode() {
    return null;
  }
  getInnerViewRef() {
    return null;
  }
  getNativeScrollRef() {
    return null;
  }
  setNativeProps() {}
  measureLayout() {}
  render() {
    return h(
      'rn-scroll',
      { _p: this.props },
      h('rn-view', { _p: { style: this.props.contentContainerStyle, __content: true } }, this.props.children)
    );
  }
}

function RefreshControl(props) {
  return h('rn-view', { _p: props });
}

function flatten(style) {
  if (!style) return undefined;
  if (!Array.isArray(style)) return style;
  const out = {};
  for (const s of style) {
    const f = flatten(s);
    if (f) Object.assign(out, f);
  }
  return out;
}

const StyleSheet = {
  create: (o) => o,
  flatten,
  compose: (a, b) => (a != null && b != null ? [a, b] : a != null ? a : b),
  hairlineWidth: 1 / WINDOW.scale,
  absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
};

const Platform = {
  OS: 'android',
  Version: 35,
  select: (o) => ('android' in o ? o.android : 'native' in o ? o.native : o.default),
};

const Alert = {
  alert(title, message, buttons) {
    state.lastAlert = { title, message, buttons: buttons ?? [] };
  },
};

function useColorScheme() {
  // LibraryScreen reads the palette exactly once per render, and nothing else
  // in the benchmarked tree calls this — so it doubles as a screen-render counter.
  counters.screen++;
  return state.colorScheme;
}

const Dimensions = {
  get: () => WINDOW,
  addEventListener: () => ({ remove() {} }),
};

module.exports = {
  __esModule: true,
  __state: state,
  WINDOW,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
  StyleSheet,
  Platform,
  Alert,
  Dimensions,
  I18nManager: { isRTL: false, getConstants: () => ({ isRTL: false }) },
  findNodeHandle: () => null,
  useColorScheme,
  useWindowDimensions: () => WINDOW,
  get FlatList() {
    return require('./flatlist').FlatList;
  },
};
