'use strict';
// Just enough DOM for react-dom/client to mount and update a tree of custom
// elements (<rn-view>, <rn-text>, <rn-scroll>) in Node. Every host instance
// carries the React Native props it was rendered with on `el._p`, which is
// what the harness uses to find press handlers and to deliver onLayout /
// onScroll / onContentSizeChange the way Fabric would after a commit.
//
// Host-side work counters (`hostStats`) approximate how much the native side
// would be asked to do per commit: element creations, prop updates on
// existing instances, and child insert/remove operations.

const hostStats = { created: 0, propUpdates: 0, inserts: 0, removes: 0 };

class Node {
  constructor(doc, nodeType, nodeName) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    return s[s.indexOf(this) + 1] ?? null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    return s[s.indexOf(this) - 1] ?? null;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child, true);
    child.parentNode = this;
    this.childNodes.push(child);
    hostStats.inserts++;
    return child;
  }
  insertBefore(child, before) {
    if (before == null) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child, true);
    const i = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, child);
    hostStats.inserts++;
    return child;
  }
  removeChild(child, moving) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    if (!moving) hostStats.removes++;
    return child;
  }
  addEventListener() {}
  removeEventListener() {}
  getRootNode() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  set textContent(v) {
    this.childNodes.forEach((c) => (c.parentNode = null));
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new Text(this.ownerDocument, String(v)));
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
}

class Text extends Node {
  constructor(doc, data) {
    super(doc, 3, '#text');
    this._data = data;
  }
  get nodeValue() {
    return this._data;
  }
  set nodeValue(v) {
    this._data = v;
    hostStats.propUpdates++;
  }
  get data() {
    return this._data;
  }
  set data(v) {
    this.nodeValue = v;
  }
  get textContent() {
    return this._data;
  }
  set textContent(v) {
    this.nodeValue = v;
  }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc, 1, tag.toUpperCase());
    this.tagName = this.nodeName;
    this.localName = tag;
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.attributes = {};
    this.style = {
      setProperty(k, v) {
        this[k] = v;
      },
      removeProperty(k) {
        delete this[k];
      },
    };
    this.__p = null;
    hostStats.created++;
  }
  // React assigns `_p` (the RN props) as a property on custom elements.
  get _p() {
    return this.__p;
  }
  set _p(v) {
    if (this.__p !== null) hostStats.propUpdates++;
    this.__p = v;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  hasAttribute(k) {
    return k in this.attributes;
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
}

class Document extends Node {
  constructor() {
    super(null, 9, '#document');
    this.ownerDocument = null;
    this.documentElement = new Element(this, 'html');
    this.body = new Element(this, 'body');
    this.activeElement = null;
  }
  createElement(tag) {
    return new Element(this, tag);
  }
  createElementNS(ns, tag) {
    return new Element(this, tag);
  }
  createTextNode(data) {
    return new Text(this, data);
  }
}

function install() {
  const document = new Document();
  const window = globalThis;
  window.window = window;
  window.document = document;
  document.defaultView = window;
  window.HTMLIFrameElement = class HTMLIFrameElement {};
  window.Element = Element;
  window.Node = Node;
  if (!window.navigator) window.navigator = { userAgent: 'node' };
  window.addEventListener = () => {};
  window.removeEventListener = () => {};
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { document, container };
}

// Depth-first walk of host elements.
function* walk(node) {
  yield node;
  for (const c of node.childNodes) if (c.nodeType === 1) yield* walk(c);
}

module.exports = { install, walk, hostStats };
