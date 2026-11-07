'use strict';
// React Native 0.86's real FlatList (react-native/Libraries/Lists/FlatList.js)
// on top of the real @react-native/virtualized-lists, with render counters
// spliced onto the class prototypes.
const path = require('path');
const { counters } = require('../counters');
const ROOT = path.resolve(__dirname, '../../..');

const RealFlatList = require(path.join(ROOT, 'node_modules/react-native/Libraries/Lists/FlatList.js')).default;
const CellRenderer = require(
  path.join(ROOT, 'node_modules/@react-native/virtualized-lists/Lists/VirtualizedListCellRenderer.js')
).default;

const flRender = RealFlatList.prototype.render;
RealFlatList.prototype.render = function () {
  counters.flatList++;
  return flRender.call(this);
};
const crRender = CellRenderer.prototype.render;
CellRenderer.prototype.render = function () {
  counters.cellRenderer++;
  return crRender.call(this);
};

module.exports = { FlatList: RealFlatList };
