'use strict';
// expo-image's Image is a React.PureComponent (expo-image/src/Image.tsx).
const React = require('react');
const { counters } = require('../counters');
class Image extends React.PureComponent {
  render() {
    counters.image++;
    return React.createElement('rn-view', { _p: this.props });
  }
}
module.exports = { __esModule: true, Image };
