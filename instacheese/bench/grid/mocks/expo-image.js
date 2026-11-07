'use strict';
// expo-image's Image is a React.PureComponent (expo-image/src/Image.tsx).
const React = require('react');
const { counters } = require('../counters');
class Image extends React.PureComponent {
  // A mount = a new native ExpoImageViewWrapper + a Glide request on device;
  // an unmount = that view torn down.
  componentDidMount() {
    counters.imageMount++;
  }
  componentWillUnmount() {
    counters.imageUnmount++;
  }
  render() {
    counters.image++;
    return React.createElement('rn-view', { _p: this.props });
  }
}
module.exports = { __esModule: true, Image };
