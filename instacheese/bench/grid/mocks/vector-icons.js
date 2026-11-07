'use strict';
// @expo/vector-icons icon sets are React.PureComponent classes (create-icon-set.js).
const React = require('react');
const { counters } = require('../counters');
class Ionicons extends React.PureComponent {
  render() {
    counters.icon++;
    return React.createElement('rn-text', { _p: this.props }, '');
  }
}
module.exports = { __esModule: true, Ionicons };
