'use strict';
// Render counters bumped by the mocks. They count component *function
// executions* (renders), which is renderer-independent: the same components
// would run the same number of times on Hermes/Fabric.
const counters = {
  screen: 0, // LibraryScreen renders (via usePalette -> useColorScheme)
  flatList: 0, // FlatList (class) render() calls
  cellRenderer: 0, // VirtualizedList CellRenderer render() calls (one per grid row)
  cell: 0, // grid cell bodies: Pressable renders with accessibilityRole="checkbox"
  image: 0, // expo-image <Image> renders (one per cell)
  imageMount: 0, // <Image> mounts (new native image view + Glide request)
  imageUnmount: 0, // <Image> unmounts
  icon: 0, // Ionicons renders
  pressable: 0,
  view: 0,
  text: 0,
};
function reset() {
  for (const k of Object.keys(counters)) counters[k] = 0;
}
function snapshot() {
  return { ...counters };
}
module.exports = { counters, reset, snapshot };
